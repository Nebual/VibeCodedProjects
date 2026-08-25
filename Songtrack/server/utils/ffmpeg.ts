import { spawn } from 'node:child_process'
import { resolveSegmentPosition } from '../../shared/utils/timeline'
import type { AfftdnFilter, EditFilter, EditList } from '#shared/types'
import type { ResolvedSegment } from '../../shared/utils/timeline'

/** Crossfade duration used to smooth every audio splice this module creates — segment joins and the afftdn training-clip splice alike — so cuts never leave an audible click. */
const SEGMENT_CROSSFADE_S = 0.02

/**
 * ffmpeg's stderr carries warnings (e.g. "could not seek", malformed-packet notices) even on a
 * successful (exit 0) run — exactly the run that later trips something else up (an ffprobe on its
 * output failing, a 0-byte file) with no other trace of why. Logging it here, unconditionally,
 * means that context is already in the server console by the time any downstream failure surfaces,
 * instead of being silently discarded because *this* process technically succeeded.
 */
function logFfmpegRun(args: string[], code: number | null, stderr: string) {
  if (!stderr.trim()) return
  const log = code === 0 ? console.log : console.error
  log(`[ffmpeg]${code === 0 ? '' : ` exit ${code}`} ffmpeg ${args.join(' ')}\n${stderr}`)
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-y', '-hide_banner', ...args]
    const proc = spawn('ffmpeg', fullArgs, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      logFfmpegRun(fullArgs, code, stderr)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

function runFfmpegCapture(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-y', '-hide_banner', ...args]
    const proc = spawn('ffmpeg', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', d => chunks.push(d))
    proc.stderr.on('data', d => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      logFfmpegRun(fullArgs, code, stderr)
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

export interface ProbeResult {
  durationS: number
  sampleRate: number
  channels: number
}

export function ffprobe(path: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    // '-v error' (not 'quiet'): quiet suppresses ffprobe's own error diagnostics too, which is
    // exactly the detail needed when this rejects — a corrupt/empty input otherwise fails with no
    // information about why at all.
    const proc = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => (stdout += d.toString()))
    proc.stderr.on('data', d => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr.slice(-1000)}`))
        return
      }
      try {
        const data = JSON.parse(stdout)
        const audioStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio')
        resolve({
          durationS: Number(data.format?.duration ?? audioStream?.duration ?? 0),
          sampleRate: Number(audioStream?.sample_rate ?? 48000),
          channels: Number(audioStream?.channels ?? 2),
        })
      } catch (e) {
        reject(e as Error)
      }
    })
  })
}

export interface PeaksResult {
  version: 1
  sampleRate: number
  samplesPerPixel: number
  length: number
  bits: 8
  channels: 1
  data: number[]
}

/** Downmixed-mono min/max peaks for the waveform display, decoded via ffmpeg (no extra binary needed). */
export async function generatePeaks(inputPath: string, bucketCount = 4000): Promise<PeaksResult> {
  const pcm = await runFfmpegCapture(['-i', inputPath, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '44100', 'pipe:1'])
  const sampleCount = Math.floor(pcm.length / 2)
  const samplesPerBucket = Math.max(1, Math.floor(sampleCount / bucketCount))
  const data: number[] = []
  for (let start = 0; start < sampleCount; start += samplesPerBucket) {
    let min = 32767
    let max = -32768
    const end = Math.min(sampleCount, start + samplesPerBucket)
    for (let i = start; i < end; i++) {
      const v = pcm.readInt16LE(i * 2)
      if (v < min) min = v
      if (v > max) max = v
    }
    data.push(Math.round(min / 256), Math.round(max / 256))
  }
  return {
    version: 1,
    sampleRate: 44100,
    samplesPerPixel: samplesPerBucket,
    length: data.length / 2,
    bits: 8,
    channels: 1,
    data,
  }
}

/** Mono PCM samples at a given sample rate — the raw material for RMS envelope analysis (auto-trim). */
export async function decodeMonoPcm16(inputPath: string, sampleRate: number): Promise<Int16Array> {
  const buf = await runFfmpegCapture(['-i', inputPath, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(sampleRate), 'pipe:1'])
  const samples = new Int16Array(Math.floor(buf.length / 2))
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2)
  return samples
}

/** Mono PCM for just a time window — used by auto-notch, which only needs to analyze the profiled noise region. */
export async function decodeMonoPcm16Window(inputPath: string, sampleRate: number, start: number, duration: number): Promise<Int16Array> {
  const buf = await runFfmpegCapture(['-ss', String(start), '-t', String(duration), '-i', inputPath, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(sampleRate), 'pipe:1'])
  const samples = new Int16Array(Math.floor(buf.length / 2))
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2)
  return samples
}

export interface RenderSource {
  id: string
  path: string
}

/**
 * Resolves an afftdn filter's noise region — captured against the full, uncropped take timeline —
 * to the actual take file + local-time span it corresponds to, for use as `RenderOptions.noiseTrainingSource`.
 * Returns undefined when there's no afftdn filter, no region set, or the region can't be resolved
 * against the given `baseSegments`/`sources` (in which case the caller should render without the
 * region rather than risk self-extracting the wrong audio from a possibly-cropped chain).
 */
export function resolveNoiseTrainingSource(
  filters: EditFilter[],
  baseSegments: ResolvedSegment[],
  sources: RenderSource[],
): { path: string, start: number, duration: number } | undefined {
  const afftdn = filters.find((f): f is AfftdnFilter => f.type === 'afftdn' && !!f.noiseRegion)
  if (!afftdn?.noiseRegion) return undefined
  const resolved = resolveSegmentPosition(baseSegments, afftdn.noiseRegion.start)
  if (!resolved) return undefined
  const source = sources.find(s => s.id === resolved.source)
  if (!source) return undefined
  return { path: source.path, start: resolved.localTime, duration: afftdn.noiseRegion.end - afftdn.noiseRegion.start }
}

/**
 * `afftdn` learns a much better noise profile from a timed sample of real
 * room tone (a hand-picked or auto-guessed quiet region) than from its own
 * blind noise-floor guess. `asendcmd` fires `sn start`/`sn stop` at the
 * region's edges, targeting this filter instance by name so multiple afftdn
 * filters in one graph (audition mode aside) never cross-talk.
 * Falls back to `tn=1` (continuous floor tracking) when there's no region —
 * the plan's documented fallback for when AGC has polluted a fixed profile.
 */
function afftdnLink(chain: string, next: string, f: AfftdnFilter, index: number, om?: 'n'): string {
  const instance = `f${index}`
  const omArg = om ? `:om=${om}` : ''
  const expr = `afftdn@${instance}=nr=${f.nr}:gs=${f.gs}${f.noiseRegion ? '' : ':tn=1'}${omArg}`
  if (!f.noiseRegion) return `[${chain}]${expr}[${next}]`
  const cmd = `${f.noiseRegion.start}-${f.noiseRegion.end} [enter] afftdn@${instance} sn start,[leave] afftdn@${instance} sn stop`
  return `[${chain}]asendcmd=c='${cmd}',${expr}[${next}]`
}

/**
 * `afftdn` is a forward-only streaming filter: a profile learned via `sn
 * start`/`sn stop` can only clean audio that comes *after* it in the
 * processed stream, never audio already emitted before that point. Since the
 * ambience sample is captured at the *tail* of a recording (after the real
 * content, not before it), wiring `sn` directly at the region's own absolute
 * position would train a profile only in time to apply to the ambience
 * itself — none of the actual recording would ever benefit.
 *
 * Instead, this synthesizes a "primed" stream: the region's own audio
 * (`trainingLabel` if the caller already has it as a separate input, e.g. a
 * short preview window that may not otherwise contain the region — or
 * self-extracted via `asplit`+`atrim` from `chain` itself when the caller's
 * chain is already the complete, self-contained timeline the region was
 * captured against) is concatenated in *front* of the real content, so `sn`
 * always has a chance to learn before any real audio needs cleaning. The
 * synthetic prefix is trimmed back off the processed output afterward.
 */
function wireAfftdnWithRegion(
  filterParts: string[],
  chain: string,
  f: AfftdnFilter,
  index: number,
  trainingLabel: string | undefined,
  om?: 'n',
): string {
  const region = f.noiseRegion!
  const trainingDuration = region.end - region.start

  let train = trainingLabel
  let main = chain
  if (!train) {
    const splitMain = `nssrc${index}`
    const splitTrain = `nssplit${index}`
    filterParts.push(`[${chain}]asplit=2[${splitMain}][${splitTrain}]`)
    train = `nstrain${index}`
    filterParts.push(`[${splitTrain}]atrim=start=${region.start}:end=${region.end},asetpts=PTS-STARTPTS[${train}]`)
    main = splitMain
  }

  // A hard concat splice between the training clip and the real content is an abrupt waveform
  // discontinuity, and afftdn's FFT-based processing rings for a few frames after a discontinuity
  // like that — audible as a blip right where the real content begins, which is exactly the point
  // the atrim below cuts back to. A short crossfade smooths the splice instead.
  const overlap = Math.min(SEGMENT_CROSSFADE_S, trainingDuration)
  const primed = `nsprimed${index}`
  filterParts.push(`[${train}][${main}]acrossfade=d=${overlap}[${primed}]`)

  const filtered = `nsfiltered${index}`
  filterParts.push(afftdnLink(primed, filtered, { ...f, noiseRegion: { start: 0, end: trainingDuration } }, index, om))

  const trimmed = `nstrimmed${index}`
  filterParts.push(`[${filtered}]atrim=start=${trainingDuration - overlap},asetpts=PTS-STARTPTS[${trimmed}]`)
  return trimmed
}

export interface RenderOptions {
  /**
   * "Listen to what's being removed": outputs only the material afftdn
   * subtracts (`om=n`), skipping every other filter, gain and fades — the
   * A/B guard against over-processing. Throws if there's no afftdn filter.
   */
  audition?: boolean
  /**
   * Label of an extra input the caller has already seeked/trimmed to exactly
   * the noiseRegion's own audio span — needed when `startChain` isn't
   * guaranteed to contain that span itself (e.g. a short preview window that
   * may fall anywhere relative to the region). Omit when `startChain` is
   * already the complete timeline the region was captured against; the
   * training clip is then self-extracted from it instead.
   */
  noiseTrainingLabel?: string
  /**
   * Explicit take + local-time span to extract the noise-training clip from, added as its own
   * ffmpeg input by `buildFilterGraph` itself. Needed whenever the region's absolute position was
   * captured against the full, uncropped take timeline (as ambience selection always is) but
   * `editList.segments` — the chain actually being rendered — may be a cropped subset of it, so
   * self-extracting from that chain could silently grab the wrong audio, or none at all if the
   * crop removed that span entirely.
   */
  noiseTrainingSource?: { path: string, start: number, duration: number }
}

export interface FilterGraph {
  inputArgs: string[]
  filterComplex: string
  outputLabel: string
}

/**
 * Appends the filters → gain → fades stages onto an existing filtergraph in
 * progress, mutating `filterParts` and returning the new final label. Split
 * out from `buildFilterGraph` so the windowed 15s denoise preview (which has
 * no segments/takes, just one file) can reuse the exact same filter-string
 * logic instead of duplicating it.
 */
function appendFilterChain(
  filterParts: string[],
  startChain: string,
  filters: EditFilter[],
  gain: EditList['gain'] | undefined,
  fades: EditList['fades'] | undefined,
  totalDuration: number | undefined,
  opts: RenderOptions,
): string {
  let chain = startChain

  if (opts.audition) {
    const afftdnFilters = filters.filter((f): f is AfftdnFilter => f.type === 'afftdn')
    if (afftdnFilters.length === 0) throw new Error('No noise-reduction filter to audition')
    afftdnFilters.forEach((f, i) => {
      if (f.noiseRegion) {
        chain = wireAfftdnWithRegion(filterParts, chain, f, i, opts.noiseTrainingLabel, 'n')
        return
      }
      const next = `filt${i}`
      filterParts.push(afftdnLink(chain, next, f, i, 'n'))
      chain = next
    })
    return chain
  }

  filters.forEach((f, i) => {
    if (f.type === 'afftdn' && f.noiseRegion) {
      chain = wireAfftdnWithRegion(filterParts, chain, f, i, opts.noiseTrainingLabel)
      return
    }
    const next = `filt${i}`
    if (f.type === 'afftdn') {
      filterParts.push(afftdnLink(chain, next, f, i))
    } else if (f.type === 'notch') {
      const chained = f.freqs.map(freq => `equalizer=f=${freq}:t=q:w=${f.q}:g=-24`).join(',')
      filterParts.push(`[${chain}]${chained}[${next}]`)
    } else if (f.type === 'highpass') {
      filterParts.push(`[${chain}]highpass=f=${f.freq}[${next}]`)
    } else if (f.type === 'agate') {
      filterParts.push(`[${chain}]agate=threshold=${f.threshold}dB:ratio=${f.ratio}[${next}]`)
    }
    chain = next
  })

  // Denoising before normalizing (rather than after) keeps afftdn looking at the recording's
  // original, un-boosted noise floor. Its noise-floor/residual-floor defaults are fixed absolute
  // dB values (-50dB/-38dB) — loudnorm's gain to reach a target LUFS can be 30dB+ on a quiet
  // recording, which lifts the noise floor above those thresholds and makes afftdn treat the
  // (now much louder) hiss as program material instead of noise, largely undoing the reduction.
  if (gain?.mode === 'loudnorm') {
    const next = `gain_${chain}`
    filterParts.push(`[${chain}]loudnorm=I=${gain.targetLufs}:TP=-1.5:LRA=11[${next}]`)
    chain = next
  }

  if (fades && totalDuration != null) {
    const next = `fade_${chain}`
    const fadeOutStart = Math.max(0, totalDuration - fades.outMs / 1000)
    filterParts.push(
      `[${chain}]afade=t=in:d=${fades.inMs / 1000},afade=t=out:st=${fadeOutStart}:d=${fades.outMs / 1000}[${next}]`,
    )
    chain = next
  }

  return chain
}

/**
 * Pure filtergraph construction, split out from `renderEditList` so the
 * string-building (segments, crossfades, filters, gain, fades) is unit
 * testable without spawning a real ffmpeg process. Shared by ingest (empty
 * filters, just the resolved take stack) and later edits/denoise (Phase 3/4
 * add filters to the same edit_list): trim each segment from its source take,
 * crossfade the joins, apply filters, then gain/fades.
 */
export function buildFilterGraph(sources: RenderSource[], editList: EditList, opts: RenderOptions = {}): FilterGraph {
  if (editList.segments.length === 0) throw new Error('Edit list has no segments')

  const uniqueSourceIds = [...new Set(editList.segments.map(s => s.source))]
  const inputArgs: string[] = []
  const inputIndex = new Map<string, number>()
  uniqueSourceIds.forEach((id, i) => {
    const src = sources.find(s => s.id === id)
    if (!src) throw new Error(`Missing source for take ${id}`)
    inputArgs.push('-i', src.path)
    inputIndex.set(id, i)
  })

  const filterParts: string[] = []

  // Reads the whole file as a plain input (no -ss/-t container-level seek) and trims to the
  // needed span via the atrim filter instead, after decode — container-level seeking is
  // unreliable on some formats (e.g. browser-recorded webm with no seek index), which can corrupt
  // or fail the read. Self-extraction from an already-decoded chain never had this problem, for
  // the same reason: it only ever trims post-decode too.
  let chainOpts = opts
  if (opts.noiseTrainingSource) {
    const { path, start, duration } = opts.noiseTrainingSource
    const trainIndex = uniqueSourceIds.length
    inputArgs.push('-i', path)
    const trainLabel = 'nstrainsrc'
    filterParts.push(`[${trainIndex}:a]atrim=start=${start}:end=${start + duration},asetpts=PTS-STARTPTS[${trainLabel}]`)
    chainOpts = { ...opts, noiseTrainingLabel: trainLabel }
  }

  const segLabels: string[] = []
  editList.segments.forEach((seg, i) => {
    const idx = inputIndex.get(seg.source)!
    const label = `seg${i}`
    filterParts.push(
      `[${idx}:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[${label}]`,
    )
    segLabels.push(label)
  })

  let chain = segLabels[0]!
  for (let i = 1; i < segLabels.length; i++) {
    const next = `cf${i}`
    filterParts.push(`[${chain}][${segLabels[i]}]acrossfade=d=${SEGMENT_CROSSFADE_S}[${next}]`)
    chain = next
  }

  const totalDuration = editList.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
  chain = appendFilterChain(filterParts, chain, editList.filters, editList.gain, editList.fades, totalDuration, chainOpts)

  return { inputArgs, filterComplex: filterParts.join(';'), outputLabel: chain }
}

/**
 * Filters-only graph over a single already-decoded input (no segments/takes
 * involved) — the windowed 15s denoise preview applies candidate filters
 * directly to a slice of the current master.
 */
export function buildFiltersOnlyGraph(inputLabel: string, filters: EditFilter[], gain?: EditList['gain'], opts: RenderOptions = {}): FilterGraph {
  const filterParts: string[] = []
  const outputLabel = appendFilterChain(filterParts, inputLabel, filters, gain, undefined, undefined, opts)
  return { inputArgs: [], filterComplex: filterParts.join(';'), outputLabel }
}

export async function renderEditList(sources: RenderSource[], editList: EditList, outputPath: string, format: 'ogg' | 'mp3', opts: RenderOptions = {}) {
  const { inputArgs, filterComplex, outputLabel } = buildFilterGraph(sources, editList, opts)
  const codecArgs = format === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '0'] : ['-c:a', 'libopus', '-b:a', '192k']

  await runFfmpeg([
    ...inputArgs,
    '-filter_complex',
    filterComplex,
    '-map',
    `[${outputLabel}]`,
    ...codecArgs,
    outputPath,
  ])
}

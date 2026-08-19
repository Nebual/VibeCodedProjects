import { spawn } from 'node:child_process'
import type { AfftdnFilter, EditFilter, EditList } from '#shared/types'

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

function runFfmpegCapture(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', d => chunks.push(d))
    proc.stderr.on('data', d => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
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
    const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path])
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
 * `afftdn` learns a much better noise profile from a timed sample of real
 * room tone (the ambience lead-in, or a hand-picked quiet region) than from
 * its own blind noise-floor guess. `asendcmd` fires `sn start`/`sn stop` at
 * the region's edges, targeting this filter instance by name so multiple
 * afftdn filters in one graph (audition mode aside) never cross-talk.
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

export interface RenderOptions {
  /**
   * "Listen to what's being removed": outputs only the material afftdn
   * subtracts (`om=n`), skipping every other filter, gain and fades — the
   * A/B guard against over-processing. Throws if there's no afftdn filter.
   */
  audition?: boolean
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
      const next = `filt${i}`
      filterParts.push(afftdnLink(chain, next, f, i, 'n'))
      chain = next
    })
    return chain
  }

  // Normalizing before the noise-reduction filters (rather than after, as this used to) gives
  // afftdn properly-leveled audio to analyze — its noise-floor/profile estimation has absolute-
  // level-dependent behavior, so feeding it a too-quiet signal makes its `nr`/`gs` controls behave
  // inconsistently (too weak at low strengths, chewing into program material at higher ones).
  if (gain?.mode === 'loudnorm') {
    const next = `gain_${chain}`
    filterParts.push(`[${chain}]loudnorm=I=${gain.targetLufs}:TP=-1.5:LRA=11[${next}]`)
    chain = next
  }

  filters.forEach((f, i) => {
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
  const crossfadeS = 0.02
  for (let i = 1; i < segLabels.length; i++) {
    const next = `cf${i}`
    filterParts.push(`[${chain}][${segLabels[i]}]acrossfade=d=${crossfadeS}[${next}]`)
    chain = next
  }

  const totalDuration = editList.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
  chain = appendFilterChain(filterParts, chain, editList.filters, editList.gain, editList.fades, totalDuration, opts)

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

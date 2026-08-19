import { spawn } from 'node:child_process'
import type { EditList } from '#shared/types'

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

export interface RenderSource {
  id: string
  path: string
}

/**
 * Builds and runs the single ffmpeg filtergraph shared by ingest (empty
 * filters, just the resolved take stack) and later edits/denoise (Phase 3/4
 * add filters to the same edit_list): trim each segment from its source take,
 * crossfade the joins, apply filters, then gain/fades.
 */
export async function renderEditList(sources: RenderSource[], editList: EditList, outputPath: string, format: 'ogg' | 'mp3') {
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

  for (const [i, f] of editList.filters.entries()) {
    const next = `filt${i}`
    if (f.type === 'afftdn') {
      filterParts.push(`[${chain}]afftdn=nr=${f.nr}:gs=${f.gs}[${next}]`)
    } else if (f.type === 'notch') {
      const chained = f.freqs.map(freq => `equalizer=f=${freq}:t=q:w=${f.q}:g=-24`).join(',')
      filterParts.push(`[${chain}]${chained}[${next}]`)
    } else if (f.type === 'highpass') {
      filterParts.push(`[${chain}]highpass=f=${f.freq}[${next}]`)
    } else if (f.type === 'agate') {
      filterParts.push(`[${chain}]agate=threshold=${f.threshold}dB:ratio=${f.ratio}[${next}]`)
    }
    chain = next
  }

  if (editList.gain?.mode === 'loudnorm') {
    const next = `gain_${chain}`
    filterParts.push(`[${chain}]loudnorm=I=${editList.gain.targetLufs}:TP=-1.5:LRA=11[${next}]`)
    chain = next
  }

  if (editList.fades) {
    const totalDuration = editList.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
    const next = `fade_${chain}`
    const fadeOutStart = Math.max(0, totalDuration - editList.fades.outMs / 1000)
    filterParts.push(
      `[${chain}]afade=t=in:d=${editList.fades.inMs / 1000},afade=t=out:st=${fadeOutStart}:d=${editList.fades.outMs / 1000}[${next}]`,
    )
    chain = next
  }

  const codecArgs = format === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '0'] : ['-c:a', 'libopus', '-b:a', '192k']

  await runFfmpeg([
    ...inputArgs,
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    `[${chain}]`,
    ...codecArgs,
    outputPath,
  ])
}

/**
 * Estimates a gain multiplier that brings a decoded buffer's RMS toward
 * `targetRms`, capped at `maxGain` and never allowed to push the loudest
 * sample past -0.2 dBFS (clip-safe). Used to drive preview-only monitoring
 * boosts — never applied to what actually gets recorded/exported.
 */
export function computeNormalizeGain(buffer: AudioBuffer, targetRms: number, maxGain = 50): number {
  const STRIDE = 8 // sampling stride keeps this cheap even for multi-minute buffers
  let sumSquares = 0
  let sampleCount = 0
  let peak = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i += STRIDE) {
      const v = data[i]!
      sumSquares += v * v
      sampleCount++
      const abs = Math.abs(v)
      if (abs > peak) peak = abs
    }
  }
  if (sampleCount === 0 || peak === 0) return 1
  const rms = Math.sqrt(sumSquares / sampleCount)
  if (rms === 0) return 1
  const targetGain = Math.min(targetRms / rms, maxGain)
  const peakSafeGain = 0.98 / peak
  return Math.min(targetGain, peakSafeGain)
}

/** Decodes the 8-bit signed peaks envelope returned by the waveform peaks API into -1..1 floats. */
export function peaksToFloatArray(data: number[]): Float32Array {
  const arr = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) arr[i] = data[i]! / 128
  return arr
}

/**
 * Same idea as `computeNormalizeGain` but over an 8-bit min/max peaks
 * envelope (as returned by the waveform peaks API) instead of full PCM —
 * lets the main master waveform get a gain estimate without decoding the
 * whole file client-side.
 */
export function computeNormalizeGainFromPeaks(peaks: Float32Array, targetRms: number, maxGain = 50): number {
  let sumSquares = 0
  let peak = 0
  for (let i = 0; i < peaks.length; i++) {
    const v = peaks[i]!
    sumSquares += v * v
    const abs = Math.abs(v)
    if (abs > peak) peak = abs
  }
  if (peaks.length === 0 || peak === 0) return 1
  const rms = Math.sqrt(sumSquares / peaks.length)
  if (rms === 0) return 1
  const targetGain = Math.min(targetRms / rms, maxGain)
  const peakSafeGain = 0.98 / peak
  return Math.min(targetGain, peakSafeGain)
}

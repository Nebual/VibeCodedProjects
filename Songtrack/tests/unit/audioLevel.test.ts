import { describe, expect, it } from 'vitest'
import { computeNormalizeGainFromPeaks } from '../../app/utils/audioLevel'

/**
 * A quiet recording with a high crest factor (peak -23dBFS, RMS -48dBFS) — matching
 * real captured takes in this app, which sit far quieter than their occasional peaks.
 * Built from two amplitude levels solved so the buffer's overall RMS lands at the target.
 */
function quietPeaks(): Float32Array {
  const peak = 0.0703 // -23 dBFS
  const targetRms = 0.0038 // -48 dBFS
  const floor = 0.001
  // rms^2 = p*peak^2 + (1-p)*floor^2, solved for the peak-sample fraction p.
  const p = (targetRms ** 2 - floor ** 2) / (peak ** 2 - floor ** 2)
  const n = 10000
  const arr = new Float32Array(n)
  const peakStride = Math.round(1 / p)
  for (let i = 0; i < n; i++) arr[i] = (i % peakStride === 0 ? peak : floor) * (i % 2 === 0 ? 1 : -1)
  return arr
}

describe('computeNormalizeGainFromPeaks', () => {
  it('applies more gain as the target level is raised, for a quiet recording with peak headroom', () => {
    const peaks = quietPeaks()
    const targetRmsAt = (db: number) => 10 ** (db / 20)

    const gainAtQuiet = computeNormalizeGainFromPeaks(peaks, targetRmsAt(-30))
    const gainAtLoud = computeNormalizeGainFromPeaks(peaks, targetRmsAt(-6))

    // The recording has ~14x of peak headroom (-23dBFS peak) available before clipping,
    // so raising the target from -30dB to -6dB should visibly raise the applied gain —
    // it must not be silently capped to the same value across that whole range.
    expect(gainAtLoud).toBeGreaterThan(gainAtQuiet)
  })
})

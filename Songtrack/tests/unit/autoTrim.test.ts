import { describe, expect, it } from 'vitest'
import { analyzeAutoTrim } from '../../server/utils/autoTrim'

const SAMPLE_RATE = 8000 // matches decodeMonoPcm16's call site in the real endpoint

/** A 440Hz tone shaped by an amplitude envelope, quantized to Int16 like real decoded PCM. */
function generateSamples(durationS: number, envelopeAt: (t: number) => number): Int16Array {
  const n = Math.round(durationS * SAMPLE_RATE)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    const carrier = Math.sin(2 * Math.PI * 440 * t)
    out[i] = Math.round(carrier * envelopeAt(t) * 32767)
  }
  return out
}

const NOISE_FLOOR_AMP = 0.001 // ~ -60dB, a quiet room tone

describe('analyzeAutoTrim', () => {
  it('does not crash on pure silence and proposes no meaningful cuts', () => {
    const duration = 10
    const samples = generateSamples(duration, () => NOISE_FLOOR_AMP)
    const result = analyzeAutoTrim(samples, duration)
    expect(result.startCut).toBeGreaterThanOrEqual(0)
    expect(result.endCut).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(result.startCut)).toBe(true)
    expect(Number.isFinite(result.endCut)).toBe(true)
  })

  it('proposes trimming lead-in and trailing silence around a loud middle section', () => {
    const duration = 40
    const samples = generateSamples(duration, (t) => {
      if (t < 5 || t > 35) return NOISE_FLOOR_AMP
      return 1
    })
    const result = analyzeAutoTrim(samples, duration)
    // The transition is a hard cutover, so both cuts should land close to the
    // actual 5s silent stretch on each side — not exact, but in the ballpark.
    expect(result.startCut).toBeGreaterThan(3)
    expect(result.startCut).toBeLessThan(6)
    expect(result.endCut).toBeGreaterThan(2)
    expect(result.endCut).toBeLessThan(6)
  })

  it('preserves a gradually decaying held chord instead of gating hard at the threshold', () => {
    const duration = 30
    const decayStart = 15
    const decayLength = 5
    const samples = generateSamples(duration, (t) => {
      if (t < decayStart) return 1
      if (t < decayStart + decayLength) {
        // linear decay from 1 down to near-silence over `decayLength` seconds
        const progress = (t - decayStart) / decayLength
        return Math.max(NOISE_FLOOR_AMP, 1 - progress)
      }
      return NOISE_FLOOR_AMP
    })
    const result = analyzeAutoTrim(samples, duration)
    // A naive hard gate at the threshold-crossing point (early in the decay)
    // would propose cutting most of the decay away. The decay-aware walk
    // should instead let most of it survive, cutting only near where it
    // actually flattens into the floor.
    expect(result.endCut).toBeLessThan(duration - decayStart - decayLength * 0.5)
  })

  it('is not fooled by a brief post-recording blip (e.g. a handling click)', () => {
    const duration = 30
    const samples = generateSamples(duration, (t) => {
      if (t < 20) return 1 // sustained loud content
      if (t < 23) return Math.max(NOISE_FLOOR_AMP, 1 - (t - 20) / 3) // 3s decay
      if (t >= 27 && t < 27.3) return 0.3 // a brief 0.3s blip well after the decay ends
      return NOISE_FLOOR_AMP
    })
    const result = analyzeAutoTrim(samples, duration)
    // If the blip were mistaken for "still playing," endCut would be pulled
    // down to ~duration - 27.3 - tailPad, i.e. well under 3s. The blip is
    // shorter than the sustain-length requirement, so it must be ignored.
    expect(result.endCut).toBeGreaterThan(4)
  })

  it('measures the noise floor near the measured amplitude, not wildly off', () => {
    const duration = 20
    const samples = generateSamples(duration, (t) => (t < 2 || t > 18 ? NOISE_FLOOR_AMP : 1))
    const result = analyzeAutoTrim(samples, duration)
    const expectedDb = 20 * Math.log10(NOISE_FLOOR_AMP)
    expect(result.noiseFloorDb).toBeGreaterThan(expectedDb - 10)
    expect(result.noiseFloorDb).toBeLessThan(expectedDb + 10)
  })
})

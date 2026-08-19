import { describe, expect, it } from 'vitest'
import { detectNoiseTones } from '../../server/utils/autoNotch'

const SAMPLE_RATE = 8000

/** Deterministic PRNG so noise-heavy test cases don't flake between runs. */
function mulberry32(seed: number) {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generateSignal(durationS: number, tones: { freq: number, amp: number }[], noiseAmp: number, seed = 1): Int16Array {
  const n = Math.round(durationS * SAMPLE_RATE)
  const rand = mulberry32(seed)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    let v = 0
    for (const tone of tones) v += Math.sin(2 * Math.PI * tone.freq * t) * tone.amp
    v += (rand() * 2 - 1) * noiseAmp
    out[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767)
  }
  return out
}

describe('detectNoiseTones', () => {
  it('returns no candidates for a region shorter than one analysis window', () => {
    const samples = generateSignal(0.5, [{ freq: 50, amp: 0.3 }], 0.05)
    expect(detectNoiseTones(samples, SAMPLE_RATE)).toEqual([])
  })

  it('detects a 50Hz mains hum and proposes its harmonics', () => {
    const samples = generateSignal(5, [{ freq: 50, amp: 0.2 }], 0.02)
    const freqs = detectNoiseTones(samples, SAMPLE_RATE)
    expect(freqs.some(f => Math.abs(f - 50) < 3)).toBe(true)
    expect(freqs.some(f => Math.abs(f - 100) < 3)).toBe(true)
    expect(freqs.some(f => Math.abs(f - 150) < 3)).toBe(true)
  })

  it('detects a 60Hz hum distinctly from a 50Hz one', () => {
    const samples = generateSignal(5, [{ freq: 60, amp: 0.2 }], 0.02)
    const freqs = detectNoiseTones(samples, SAMPLE_RATE)
    expect(freqs.some(f => Math.abs(f - 60) < 3)).toBe(true)
    expect(freqs.some(f => Math.abs(f - 50) < 3)).toBe(false)
  })

  it('does not hallucinate stable tones from pure broadband noise', () => {
    const samples = generateSignal(5, [], 0.2, 7)
    const freqs = detectNoiseTones(samples, SAMPLE_RATE)
    expect(freqs.length).toBeLessThanOrEqual(2)
  })

  it('finds a higher, non-mains tone without expanding harmonics past the ceiling', () => {
    const samples = generateSignal(5, [{ freq: 800, amp: 0.25 }], 0.02)
    const freqs = detectNoiseTones(samples, SAMPLE_RATE, { harmonicMaxHz: 1000 })
    expect(freqs.some(f => Math.abs(f - 800) < 5)).toBe(true)
    // 800Hz is above the default mains/motor fundamental ceiling (130Hz), so no 1600Hz harmonic
    expect(freqs.some(f => Math.abs(f - 1600) < 5)).toBe(false)
  })

  it('caps the number of returned candidates', () => {
    const samples = generateSignal(5, [{ freq: 50, amp: 0.2 }], 0.02)
    const freqs = detectNoiseTones(samples, SAMPLE_RATE, { maxCandidates: 2 })
    expect(freqs.length).toBeLessThanOrEqual(2)
  })
})

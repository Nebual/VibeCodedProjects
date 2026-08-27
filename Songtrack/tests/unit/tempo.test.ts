import { describe, expect, it } from 'vitest'
import { estimateBeatGrid, estimateTempo } from '../../server/utils/tempo'
import type { TranscribedNote } from '../../shared/types'

/** `count` notes, one every `beat` seconds, starting at `offset`. */
function pulse(bpm: number, count: number, offset = 0, jitterMs = 0): TranscribedNote[] {
  const beat = 60 / bpm
  return Array.from({ length: count }, (_, i) => {
    // Deterministic pseudo-jitter — a real performance is never exactly on the grid, and a test
    // that only ever sees perfect input proves nothing about real transcriptions.
    const jitter = jitterMs === 0 ? 0 : (Math.sin(i * 12.9898) * jitterMs) / 1000
    const start = offset + i * beat + jitter
    return { pitch: 60 + (i % 5), start, end: start + beat * 0.8, instrument: 'acoustic_piano' }
  })
}

describe('estimateTempo', () => {
  it('recovers a steady tempo from onsets alone', () => {
    expect(estimateTempo(pulse(120, 32))!.bpm).toBeCloseTo(120, 0)
  })

  it('recovers the awkward tempo the sidecar throws away', () => {
    // The real case: upstream fits 81.0 BPM, judges the beats too irregular, raises, and the
    // number survives only in an exception message. We have to find it ourselves.
    expect(estimateTempo(pulse(81, 40))!.bpm).toBeCloseTo(81, 0)
  })

  it('survives realistic performance jitter', () => {
    const bpm = estimateTempo(pulse(96, 40, 0, 25))!.bpm
    expect(bpm).toBeGreaterThan(92)
    expect(bpm).toBeLessThan(100)
  })

  it('pulls an octave error into the range people actually notate in', () => {
    // 240 bpm of onsets is far more naturally read as 120.
    const est = estimateTempo(pulse(240, 60))!
    expect(est.bpm).toBeGreaterThanOrEqual(60)
    expect(est.bpm).toBeLessThanOrEqual(160)
  })

  it('finds the phase of a grid that does not start at zero', () => {
    const est = estimateTempo(pulse(120, 32, 0.25))!
    const beat = 60 / est.bpm
    // The downbeat should land on the same phase as the notes, modulo a beat.
    const phaseError = Math.abs(((est.firstDownbeat - 0.25) % beat + beat) % beat)
    expect(Math.min(phaseError, beat - phaseError)).toBeLessThan(0.05)
  })

  it('reports low confidence for onsets with no periodicity', () => {
    const random = [0, 0.13, 0.9, 1.05, 2.7, 2.72, 4.9, 7.3, 7.35, 11.1]
    const notes = random.map(t => ({ pitch: 60, start: t, end: t + 0.1, instrument: 'p' }))
    const steady = estimateTempo(pulse(120, 40))!
    const noisy = estimateTempo(notes)
    if (noisy) expect(noisy.confidence).toBeLessThan(steady.confidence)
  })

  it('refuses to guess from too few notes', () => {
    expect(estimateTempo([])).toBeNull()
    expect(estimateTempo(pulse(120, 3))).toBeNull()
  })

  it('refuses when every note starts at the same instant', () => {
    const chord = [60, 64, 67, 72].map(pitch => ({ pitch, start: 1, end: 2, instrument: 'p' }))
    expect(estimateTempo(chord)).toBeNull()
  })
})

describe('estimateBeatGrid', () => {
  it('produces a grid usable straight away, defaulting the meter to 4/4', () => {
    const grid = estimateBeatGrid(pulse(100, 40))!
    expect(grid.bpm).toBeCloseTo(100, 0)
    expect(grid.beatsPerBar).toBe(4)
    expect(grid.subdivision).toBe(4)
  })

  it('is null when no tempo can be estimated', () => {
    expect(estimateBeatGrid([])).toBeNull()
  })
})

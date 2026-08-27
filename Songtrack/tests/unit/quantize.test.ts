import { describe, expect, it } from 'vitest'
import {
  barLines,
  gridStep,
  onsetError,
  pickupBeats,
  quantizeNotes,
  snapTime,
} from '../../server/utils/quantize'
import type { BeatGrid, TranscribedNote } from '../../shared/types'

/** 120 bpm, 4/4, 16th-note grid: one beat = 0.5s, one step = 0.125s. */
const GRID: BeatGrid = {
  bpm: 120,
  beatsPerBar: 4,
  firstDownbeat: 0,
  onsetDelay: 0,
  subdivision: 4,
}

function note(start: number, end: number, pitch = 60): TranscribedNote {
  return { pitch, start, end, instrument: 'acoustic_piano' }
}

describe('gridStep', () => {
  it('divides a beat by the subdivision', () => {
    expect(gridStep(GRID)).toBeCloseTo(0.125, 10)
    expect(gridStep({ ...GRID, subdivision: 2 })).toBeCloseTo(0.25, 10)
    expect(gridStep({ ...GRID, subdivision: 3 })).toBeCloseTo(1 / 6, 10)
  })
})

describe('snapTime', () => {
  it('leaves a time already on a grid point exactly where it is', () => {
    expect(snapTime(0.5, GRID)).toBeCloseTo(0.5, 10)
    expect(snapTime(0, GRID)).toBeCloseTo(0, 10)
  })

  it('moves a time between two points to the nearer one', () => {
    expect(snapTime(0.13, GRID)).toBeCloseTo(0.125, 10)
    expect(snapTime(0.18, GRID)).toBeCloseTo(0.125, 10)
    expect(snapTime(0.19, GRID)).toBeCloseTo(0.25, 10)
  })

  it('snaps a note before the first downbeat backwards, not forwards', () => {
    // This is where a naive floor()/ceil() implementation has its off-by-one.
    const grid = { ...GRID, firstDownbeat: 1 }
    expect(snapTime(0.9, grid)).toBeCloseTo(0.875, 10)
    expect(snapTime(0.8, grid)).toBeCloseTo(0.75, 10)
    expect(snapTime(0.44, grid)).toBeCloseTo(0.5, 10)
  })

  it('honours a non-zero first downbeat as the grid origin', () => {
    const grid = { ...GRID, firstDownbeat: 0.31 }
    expect(snapTime(0.31, grid)).toBeCloseTo(0.31, 10)
    expect(snapTime(0.44, grid)).toBeCloseTo(0.435, 10)
  })
})

describe('quantizeNotes', () => {
  it('snaps starts and ends', () => {
    const [n] = quantizeNotes([note(0.13, 0.62)], GRID)
    expect(n!.start).toBeCloseTo(0.125, 10)
    expect(n!.end).toBeCloseTo(0.625, 10)
  })

  it('never collapses a note to zero length — a fast run stays notes, not rests', () => {
    const [n] = quantizeNotes([note(0.50, 0.53)], GRID)
    expect(n!.start).toBeCloseTo(0.5, 10)
    expect(n!.end).toBeCloseTo(0.625, 10)
    expect(n!.end - n!.start).toBeCloseTo(gridStep(GRID), 10)
  })

  it('keeps ordering by onset even when snapping reorders neighbours', () => {
    const out = quantizeNotes([note(0.62, 0.9, 67), note(0.13, 0.5, 60)], GRID)
    expect(out.map(n => n.pitch)).toEqual([60, 67])
  })

  it('preserves pitch and instrument', () => {
    const out = quantizeNotes([{ pitch: 42, start: 0.3, end: 0.4, instrument: 'drums' }], GRID)
    expect(out[0]).toMatchObject({ pitch: 42, instrument: 'drums' })
  })

  it('is idempotent — quantizing already-quantized notes changes nothing', () => {
    const once = quantizeNotes([note(0.13, 0.62), note(0.9, 1.3)], GRID)
    const twice = quantizeNotes(once, GRID)
    expect(twice).toEqual(once)
  })

  it('handles an empty list', () => {
    expect(quantizeNotes([], GRID)).toEqual([])
  })
})

describe('onsetError', () => {
  it('is zero on a perfectly quantized sequence', () => {
    const notes = [0, 0.5, 1, 1.5].map(t => note(t, t + 0.4))
    expect(onsetError(notes, GRID)).toBeCloseTo(0, 6)
  })

  it('is zero for no notes at all', () => {
    expect(onsetError([], GRID)).toBe(0)
  })

  it('reports the mean absolute distance in milliseconds', () => {
    // 0.02s and 0.04s off the nearest 16th → mean 30 ms.
    expect(onsetError([note(0.02, 0.3), note(0.46, 0.7)], GRID)).toBeCloseTo(30, 6)
  })

  it('roughly halves when a half-time estimate is corrected', () => {
    // Quarter notes at 120bpm land on 0, 0.5, 1.0, ... A half-time grid (60bpm) with the same
    // subdivision has a coarser step, so every other onset sits further from a grid point.
    const notes = [0, 0.5, 1, 1.5, 2, 2.5].map(t => note(t, t + 0.4))
    const halfTime: BeatGrid = { ...GRID, bpm: 60, subdivision: 1 }
    const correct: BeatGrid = { ...GRID, bpm: 120, subdivision: 1 }
    expect(onsetError(notes, correct)).toBeCloseTo(0, 6)
    expect(onsetError(notes, halfTime)).toBeGreaterThan(200)
  })
})

describe('barLines', () => {
  it('places a line every bar from the first downbeat', () => {
    expect(barLines(GRID, 4.1)).toEqual([0, 2, 4])
  })

  it('walks back to cover bars before a late-detected downbeat', () => {
    // A detector that lands on a downbeat several bars in must not leave the opening
    // of the piece with no barlines at all.
    const lines = barLines({ ...GRID, firstDownbeat: 4.5 }, 6.6)
    expect(lines[0]).toBeCloseTo(0.5, 10)
    expect(lines).toContain(4.5)
    expect(lines[lines.length - 1]).toBeCloseTo(6.5, 10)
  })

  it('never emits a negative barline for a pickup that starts inside the first bar', () => {
    const lines = barLines({ ...GRID, firstDownbeat: 0.5 }, 2.6)
    expect(lines.every(t => t >= 0)).toBe(true)
    expect(lines[0]).toBeCloseTo(0.5, 10)
    expect(lines[lines.length - 1]).toBeCloseTo(2.5, 10)
  })

  it('respects beats per bar', () => {
    expect(barLines({ ...GRID, beatsPerBar: 3 }, 3.1)).toEqual([0, 1.5, 3])
  })
})

describe('pickupBeats', () => {
  it('is zero when the music starts on a downbeat', () => {
    expect(pickupBeats(GRID)).toBe(0)
  })

  it('reports the leading partial bar in beats', () => {
    // firstDownbeat 1.5s at 120bpm = 3 beats in, so 3 beats of pickup in a 4/4 bar.
    expect(pickupBeats({ ...GRID, firstDownbeat: 1.5 })).toBeCloseTo(3, 6)
  })

  it('treats a whole number of bars as no pickup at all', () => {
    expect(pickupBeats({ ...GRID, firstDownbeat: 2 })).toBe(0)
    expect(pickupBeats({ ...GRID, firstDownbeat: 4 })).toBe(0)
  })

  it('does not report a 0.999-beat pickup from float noise', () => {
    expect(pickupBeats({ ...GRID, firstDownbeat: 2 - 1e-9 })).toBe(0)
  })
})

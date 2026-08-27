import { describe, expect, it } from 'vitest'
import { alignDownbeat, bestPhaseWithinPeriod } from '../../shared/utils/grid'
import { onsetError } from '../../server/utils/quantize'
import type { BeatGrid, TranscribedNote } from '../../shared/types'

/** 120bpm, 16ths: beat 0.5s, step 0.125s. */
const GRID: BeatGrid = {
  bpm: 120, beatsPerBar: 4, firstDownbeat: 0, onsetDelay: 0, subdivision: 4,
}

function dragged(offset: number): TranscribedNote[] {
  return [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, i) => ({
    pitch, start: i * 0.5 + offset, end: i * 0.5 + offset + 0.4, instrument: 'acoustic_piano',
  }))
}

describe('bestPhaseWithinPeriod', () => {
  it('finds the offset a performance is dragging by', () => {
    const starts = dragged(0.04).map(n => n.start)
    expect(bestPhaseWithinPeriod(starts, 0.125)).toBeCloseTo(0.04, 2)
  })

  it('returns a phase inside one step, never larger', () => {
    const starts = dragged(0.09).map(n => n.start)
    const phase = bestPhaseWithinPeriod(starts, 0.125)
    expect(phase).toBeGreaterThanOrEqual(0)
    expect(phase).toBeLessThan(0.125)
  })

  it('is zero for notes already on the grid', () => {
    expect(bestPhaseWithinPeriod(dragged(0).map(n => n.start), 0.125)).toBeCloseTo(0, 2)
  })

  it('copes with no notes', () => {
    expect(bestPhaseWithinPeriod([], 0.125)).toBe(0)
  })
})

describe('alignDownbeat', () => {
  it('puts the beats on the notes, so quantized onsets land on beats not subdivisions', () => {
    // The case that matters for notation: onsets a hair BEFORE each beat. Aligning to 16ths would
    // pick a phase of 0.085 and syncopate everything; aligning to the beat picks 0.46.
    const starts = [0.46, 0.96, 1.46, 1.96, 2.46]
    const aligned = alignDownbeat(starts, 120, 4, 0)
    const beat = 0.5
    for (const t of starts) {
      const beatsFromDownbeat = (t - aligned) / beat
      expect(Math.abs(beatsFromDownbeat - Math.round(beatsFromDownbeat))).toBeLessThan(0.05)
    }
  })

  it('drives onset error down to nothing on a uniformly dragged performance', () => {
    const notes = dragged(0.04)
    const before = onsetError(notes, GRID)
    const aligned = alignDownbeat(notes.map(n => n.start), GRID.bpm, GRID.subdivision, 0)
    const after = onsetError(notes, { ...GRID, firstDownbeat: aligned })
    expect(before).toBeGreaterThan(30)
    expect(after).toBeLessThan(5)
  })

  it('keeps the bar start the user chose', () => {
    const notes = dragged(0.04)
    const beat = 60 / GRID.bpm
    // Downbeat two beats in: aligning must not re-bar the piece back to beat one.
    const aligned = alignDownbeat(notes.map(n => n.start), GRID.bpm, GRID.subdivision, 2 * beat)
    expect(Math.round(aligned / beat)).toBe(2)
  })

  it('never returns a negative downbeat', () => {
    expect(alignDownbeat(dragged(0.04).map(n => n.start), 120, 4, 0)).toBeGreaterThanOrEqual(0)
  })

  it('is a no-op on nonsense input rather than throwing', () => {
    expect(alignDownbeat([], 0, 4, 1.25)).toBe(1.25)
  })
})

describe('the whole-step invariance that makes 16th-snapping useless', () => {
  it('moving the downbeat by exactly one step leaves every onset where it was', () => {
    const notes = dragged(0.04)
    const step = (60 / GRID.bpm) / GRID.subdivision
    // Same grid points, so identical onset error — only the barlines moved, which is precisely
    // what turns a clean score into a syncopated one.
    expect(onsetError(notes, { ...GRID, firstDownbeat: step }))
      .toBeCloseTo(onsetError(notes, GRID), 6)
    expect(onsetError(notes, { ...GRID, firstDownbeat: 60 / GRID.bpm }))
      .toBeCloseTo(onsetError(notes, GRID), 6)
  })

  it('a shift smaller than one step does change the alignment', () => {
    const notes = dragged(0.04)
    const step = (60 / GRID.bpm) / GRID.subdivision
    expect(onsetError(notes, { ...GRID, firstDownbeat: step / 2 }))
      .not.toBeCloseTo(onsetError(notes, GRID), 3)
  })
})

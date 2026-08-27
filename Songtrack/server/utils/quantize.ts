import type { BeatGrid, TranscribedNote } from '../../shared/types'

/**
 * Snapping a performance onto a known grid is arithmetic, and `events.json` means we already have
 * the note events — so re-barring a piece at a corrected tempo is a few milliseconds of maths
 * rather than another run of a 103M-parameter model. Doing it here also avoids forking upstream to
 * add a re-quantize endpoint, matching the precedent set by `server/utils/autoNotch.ts`.
 *
 * Why any of this is needed: the transcription is a *performance*, not a score. Its onsets carry
 * real human microtiming, which is exactly why it sounds good — and exactly why notation software
 * renders an onset 30 ms off the beat as a tied 128th note or a spurious triplet.
 */

/** Seconds per grid step. `subdivision` is steps per beat: 2 = 8ths, 4 = 16ths, 3 = 8th triplets. */
export function gridStep(grid: BeatGrid): number {
  return (60 / grid.bpm) / grid.subdivision
}

/**
 * Snaps one time to the nearest grid point.
 *
 * Note the rounding is relative to `firstDownbeat`, so a note *before* the first downbeat snaps
 * backwards rather than forwards — `Math.round` handles negatives correctly here, which is
 * precisely where an off-by-one step would otherwise live.
 */
export function snapTime(t: number, grid: BeatGrid): number {
  const step = gridStep(grid)
  return grid.firstDownbeat + Math.round((t - grid.firstDownbeat) / step) * step
}

/**
 * Snaps every note, preserving onset ordering and never collapsing a note to zero length: a note
 * whose start and end land on the same grid point keeps one step of duration. That is what makes a
 * fast run engrave as notes rather than silently vanish into rests.
 */
export function quantizeNotes(notes: TranscribedNote[], grid: BeatGrid): TranscribedNote[] {
  const step = gridStep(grid)
  return notes
    .map((note) => {
      const start = snapTime(note.start, grid)
      const end = snapTime(note.end, grid)
      return { ...note, start, end: end > start ? end : start + step }
    })
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

/**
 * Mean absolute distance, in milliseconds, from each onset to the grid point it snapped to.
 *
 * This is the headline number in the tempo editor and the honest feedback signal for whether a
 * grid is right: a correct grid sits low, and a half-time or misplaced-downbeat estimate sits
 * high. It is bounded above by half a step, so it is only comparable between grids of the same
 * subdivision — which is exactly how the editor uses it.
 */
export function onsetError(notes: TranscribedNote[], grid: BeatGrid): number {
  if (notes.length === 0) return 0
  let total = 0
  for (const note of notes) total += Math.abs(note.start - snapTime(note.start, grid))
  return (total / notes.length) * 1000
}

/**
 * Where bar lines fall, from `firstDownbeat` up to `endTime`. Used both for the piano roll's grid
 * overlay and for working out the pickup bar when engraving.
 */
export function barLines(grid: BeatGrid, endTime: number): number[] {
  const barDuration = (60 / grid.bpm) * grid.beatsPerBar
  const lines: number[] = []
  // Walk backwards from the first downbeat as well, so a detector that lands on a downbeat
  // several bars into the piece doesn't leave the opening with no barlines at all. Lines before
  // t=0 aren't emitted — for an ordinary pickup the preceding barline is off the front of the
  // audio and there is nothing to draw.
  for (let t = grid.firstDownbeat; t >= 0; t -= barDuration) lines.unshift(t)
  for (let t = grid.firstDownbeat + barDuration; t <= endTime; t += barDuration) lines.push(t)
  return lines
}

/**
 * The leading partial bar, in beats, when the piece starts mid-bar.
 *
 * Emitting this as a pickup (rather than padding the start with silence) is what keeps every
 * subsequent barline in the right place — pad instead and the whole piece sits one anacrusis off.
 * Returns 0 when the music starts on a downbeat.
 */
export function pickupBeats(grid: BeatGrid): number {
  if (grid.firstDownbeat <= 0) return 0
  const beatDuration = 60 / grid.bpm
  const beats = grid.firstDownbeat / beatDuration
  const remainder = beats % grid.beatsPerBar
  // Within a thousandth of a beat of a full bar is a full bar, not a 0.999-beat pickup.
  return remainder < 1e-3 || grid.beatsPerBar - remainder < 1e-3 ? 0 : remainder
}

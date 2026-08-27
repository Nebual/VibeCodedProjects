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
 * Moves the downbeat to the beat nearest `time`, keeping the grid's existing phase.
 *
 * This is what "set the first downbeat" has to mean. Moving it by a *fraction* of a beat leaves
 * the grid points where they are and slides the barlines between them, so every note becomes
 * syncopated and the engraving fills with ties and rests — technically a correct rendering of a
 * meaningless instruction. The real use is fixing a downbeat that landed on beat 3 instead of
 * beat 1, which is a whole-beat move, and a whole-beat move leaves the notes exactly where they
 * are relative to the beat.
 */
export function snapDownbeat(time: number, grid: BeatGrid): number {
  const beat = 60 / grid.bpm
  const moved = grid.firstDownbeat + Math.round((time - grid.firstDownbeat) / beat) * beat
  // Never before the start of the recording; step forward a beat at a time if rounding went under.
  let out = moved
  while (out < -1e-9) out += beat
  return Math.max(0, Math.round(out * 10000) / 10000)
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
 * How to lay a quantized transcription out as a score.
 *
 * `firstDownbeat` is a *phase*: it says where bar 1 begins, and it can legitimately sit anywhere,
 * including a fraction of a beat into the recording. Notation has no way to express that — a score
 * has no absolute wall-clock time, only positions relative to barlines — so the fractional part has
 * to be absorbed by moving the notes rather than declared as a meter.
 *
 * Getting that wrong is not subtle. Emitting a sub-beat opening bar (a `1/16` or `2/16` time
 * signature) makes MuseScore's importer *discard* the odd meter while keeping tick positions that
 * were computed against it, and the score comes back with duplicated notes, stray rests and
 * pitches apparently shifted. Measured directly: a clean C major scale engraves perfectly at
 * firstDownbeat 0, 0.5, 1.0 and 1.5 s (whole beats), and is mangled at 0.125, 0.25 and 0.31 s.
 *
 * So: round the lead-in to a whole number of beats, shift every note by the difference, and only
 * ever emit a pickup meter with the same beat unit as the main one.
 */
export interface ScoreLayout {
  /** Whole beats before the first full bar. 0 when the music starts on a downbeat. */
  pickupBeats: number
  /** Seconds to add to every note time so the first downbeat lands exactly on a barline. */
  shift: number
}

export function scoreLayout(grid: BeatGrid, earliestNoteStart = 0): ScoreLayout {
  const beatDuration = 60 / grid.bpm
  const beatsIn = grid.firstDownbeat / beatDuration
  let wholeBeatsIn = Math.round(beatsIn)
  // Within a thousandth of a beat of a bar boundary is a bar boundary, not a 0.999-beat pickup.
  if (Math.abs(beatsIn - wholeBeatsIn) < 1e-3) wholeBeatsIn = Math.round(beatsIn)

  let shift = wholeBeatsIn * beatDuration - grid.firstDownbeat
  // Rounding down would drag the opening note before the start of the score. Give it another
  // beat of room rather than truncating music off the front.
  while (earliestNoteStart + shift < -1e-9) {
    wholeBeatsIn += 1
    shift += beatDuration
  }

  return {
    pickupBeats: ((wholeBeatsIn % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar,
    shift,
  }
}

/**
 * The leading partial bar in whole beats. Kept as a thin wrapper over `scoreLayout` because it
 * reads better at call sites that only care whether there *is* a pickup.
 */
export function pickupBeats(grid: BeatGrid): number {
  return scoreLayout(grid).pickupBeats
}

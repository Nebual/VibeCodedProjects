/**
 * Beat-grid phase maths, shared by the server's tempo estimator and the tempo editor in the
 * browser so both agree on what "aligned" means.
 *
 * The counter-intuitive bit, measured against a real MuseScore: moving the first downbeat by
 * exactly one grid step does **nothing** to alignment. The set of grid points is
 * `{firstDownbeat + k * step}`, so shifting the origin by a whole step maps it onto itself —
 * every note snaps to the same time as before — while the barlines *do* move. The result is a
 * piece that is identical except that every note is now off-beat: with 16th-note subdivision,
 * nudging the downbeat by a 16th turned a clean 8-note scale into 2 ties and 10 stray rests.
 *
 * What actually improves alignment is a shift *smaller* than one step, which moves the grid points
 * themselves and lets the notes re-snap. That's what these functions find.
 */

/** Mean absolute distance from each onset to its nearest grid point, in seconds. */
function phaseError(starts: number[], phase: number, step: number): number {
  if (starts.length === 0) return 0
  let total = 0
  for (const t of starts) {
    const rel = t - phase
    total += Math.abs(rel - Math.round(rel / step) * step)
  }
  return total / starts.length
}

/** The offset within one period that puts the onsets closest to a grid of that period. */
export function bestPhaseWithinPeriod(starts: number[], period: number, resolution = 400): number {
  if (starts.length === 0 || period <= 0) return 0
  let best = { phase: 0, error: Infinity }
  for (let i = 0; i < resolution; i++) {
    const phase = (i / resolution) * period
    const error = phaseError(starts, phase, period)
    if (error < best.error) best = { phase, error }
  }
  return best.phase
}

/**
 * A first downbeat that keeps the user's chosen bar start but slides the grid onto the notes.
 *
 * The whole-beat part of `currentFirstDownbeat` is preserved — that part says *which* beat begins
 * the bar, and changing it would re-bar the piece behind the user's back. Only the sub-step
 * remainder is replaced.
 */
export function alignDownbeat(
  noteStarts: number[],
  bpm: number,
  /** Unused now that alignment is beat-relative; kept so callers need not change. */
  _subdivision: number,
  currentFirstDownbeat: number,
): number {
  const beat = 60 / bpm
  if (!Number.isFinite(beat) || beat <= 0) return currentFirstDownbeat

  // Aligned to the BEAT, not to the subdivision. Minimising distance to 16th-note points makes the
  // grid chase the performance's microtiming, and the notes then land on odd subdivisions relative
  // to the barlines: measured on a real transcription, aligning at 16th resolution turned seven
  // clean quarter notes into two halves, two quarters, two eighths, a 16th and nine rests.
  // Aligning to the beat is what puts notes on beats, which is what engraves cleanly.
  const wholeBeats = Math.round(currentFirstDownbeat / beat)
  const phase = bestPhaseWithinPeriod(noteStarts, beat)
  // Keep it inside the first bar's worth of time and never negative.
  const aligned = wholeBeats * beat + phase
  return Math.max(0, Math.round(aligned * 10000) / 10000)
}

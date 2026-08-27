import type { BeatGrid, TranscribedNote } from '../../shared/types'
import { DEFAULT_SUBDIVISION } from '../../shared/types'

/**
 * Estimates a tempo from note onsets alone.
 *
 * This exists because upstream throws its own estimate away. `detect_beat_grid` fits a line to
 * beat_this's beats and raises `BeatDetectionError` when they deviate too far from a constant
 * tempo — and the BPM it fitted survives only inside the exception's message text ("beats deviate
 * 4449 ms RMS from a constant 81.0 BPM"). Under `detect_tempo=best-effort` the server swallows
 * that and sends `beat_grid: null`, so a perfectly serviceable estimate is unreachable through
 * the API and the UI would otherwise fall back to a meaningless 120.
 *
 * A rough tempo is far better than a placeholder here: it only has to be close enough that the
 * user's ×2/÷2 buttons and downbeat click can finish the job.
 *
 * The method is autocorrelation over an onset impulse train, which is the standard approach and,
 * unlike "pick the grid with the smallest onset error", does not degenerate towards ever-faster
 * tempos — a finer grid always fits better, so error alone has no minimum worth finding.
 */

const MIN_BPM = 40
const MAX_BPM = 210
/** Impulse train resolution. 5 ms is finer than the model's own onset accuracy. */
const BIN_S = 0.005
/** Tempo octave errors are the common failure; prefer a period landing in this range. */
const PREFERRED_MIN_BPM = 60
const PREFERRED_MAX_BPM = 160

export interface TempoEstimate {
  bpm: number
  firstDownbeat: number
  /** 0–1. The autocorrelation peak's strength relative to the mean; low means "don't trust this". */
  confidence: number
}

/** Null when there is too little to work with — two notes cannot imply a tempo. */
export function estimateTempo(notes: TranscribedNote[]): TempoEstimate | null {
  const onsets = notes.map(n => n.start).sort((a, b) => a - b)
  if (onsets.length < 4) return null

  const span = onsets[onsets.length - 1]! - onsets[0]!
  if (span <= 0) return null

  const bins = Math.ceil(span / BIN_S) + 1
  const signal = new Float64Array(bins)
  for (const t of onsets) {
    const i = Math.round((t - onsets[0]!) / BIN_S)
    if (i >= 0 && i < bins) signal[i] += 1
  }

  const minLag = Math.floor((60 / MAX_BPM) / BIN_S)
  const maxLag = Math.min(bins - 1, Math.ceil((60 / MIN_BPM) / BIN_S))
  if (maxLag <= minLag) return null

  // Raw correlation, deliberately NOT divided by the overlap length. Normalising by
  // (bins - lag) over-rewards long lags: on a perfect 120 BPM pulse it scored lag 300 at
  // 0.01036 against lag 100's 0.01033, and so returned 80 BPM for a textbook 120. The raw sum
  // falls away naturally with lag, which is the bias we actually want.
  const scores = new Float64Array(maxLag + 1)
  let peak = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < bins; i++) sum += signal[i]! * signal[i + lag]!
    scores[lag] = sum
    if (sum > peak) peak = sum
  }
  if (peak <= 0) return null

  // The smallest lag that still scores near the peak — autocorrelation is just as strong at two
  // and three times the true period, and the fundamental is the one worth reporting.
  const PEAK_TOLERANCE = 0.9
  let bestLag = maxLag
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (scores[lag]! >= peak * PEAK_TOLERANCE) { bestLag = lag; break }
  }

  const bpm = pickOctave(60 / (bestLag * BIN_S))
  const firstDownbeat = bestPhase(onsets, bpm)

  return {
    bpm: Math.round(bpm * 1000) / 1000,
    firstDownbeat,
    confidence: gridAgreement(onsets, bpm, firstDownbeat),
  }
}

/**
 * Autocorrelation peaks just as happily at half or double the real tempo. Nudge the result into
 * the range people actually notate in — this is the same half-time/double-time confusion the
 * tempo editor's ×2 and ÷2 buttons exist to fix, so getting it approximately right up front
 * saves most users a click.
 */
function pickOctave(bpm: number): number {
  let out = bpm
  while (out < PREFERRED_MIN_BPM && out * 2 <= MAX_BPM) out *= 2
  while (out > PREFERRED_MAX_BPM && out / 2 >= MIN_BPM) out /= 2
  return out
}

/**
 * Where the grid should start: the offset within one beat that puts the most onsets nearest a
 * beat line. Returned as a time in the first beat, so it doubles as `firstDownbeat`.
 */
function bestPhase(onsets: number[], bpm: number): number {
  const beat = 60 / bpm
  const steps = 100
  let best = { phase: 0, error: Infinity }
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * beat
    let error = 0
    for (const t of onsets) {
      const rel = t - phase
      error += Math.abs(rel - Math.round(rel / beat) * beat)
    }
    if (error < best.error) best = { phase, error }
  }
  // A downbeat must not sit after the first note; fold it back into [0, beat).
  return Math.max(0, Math.round(best.phase * 10000) / 10000)
}

/**
 * Fraction of onsets landing within a sixth of a beat of a beat line.
 *
 * A directly interpretable score, unlike a peak-to-mean ratio of the correlation (which saturated
 * at 1 for periodic and random input alike). Random onsets score around a third by chance; a
 * steady pulse scores near 1.
 */
function gridAgreement(onsets: number[], bpm: number, firstDownbeat: number): number {
  const beat = 60 / bpm
  const tolerance = beat / 6
  let near = 0
  for (const t of onsets) {
    const rel = t - firstDownbeat
    if (Math.abs(rel - Math.round(rel / beat) * beat) <= tolerance) near++
  }
  return near / onsets.length
}

/**
 * A complete grid to fall back on when the sidecar detected none. `beatsPerBar` cannot be inferred
 * from onsets with any confidence, so it takes the 4/4 that notation software assumes anyway.
 */
export function estimateBeatGrid(
  notes: TranscribedNote[],
  /**
   * A BPM to take on trust instead of estimating one — the sidecar's own rejected fit, which
   * comes from a trained beat tracker and beats autocorrelation over transcribed onsets. The
   * phase is still worked out here, because the hint carries no downbeat.
   */
  knownBpm?: number,
): BeatGrid | null {
  const estimate = knownBpm && knownBpm > 0
    ? { bpm: Math.round(knownBpm * 1000) / 1000, firstDownbeat: bestPhase(notes.map(n => n.start).sort((a, b) => a - b), knownBpm), confidence: 1 }
    : estimateTempo(notes)
  if (!estimate) return null
  return {
    bpm: estimate.bpm,
    beatsPerBar: 4,
    firstDownbeat: estimate.firstDownbeat,
    onsetDelay: 0,
    subdivision: DEFAULT_SUBDIVISION,
    source: 'estimated',
  }
}

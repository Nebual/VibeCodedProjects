export interface EditSegment {
  source: string // take id
  start: number // seconds, within the source take
  end: number
}

export interface AfftdnFilter {
  type: 'afftdn'
  nr: number // noise_reduction, dB
  gs: number // gain_smooth
  noiseRegion?: { start: number; end: number }
}

export interface NotchFilter {
  type: 'notch'
  freqs: number[]
  q: number
}

export interface HighpassFilter {
  type: 'highpass'
  freq: number
}

export interface AgateFilter {
  type: 'agate'
  threshold: number
  ratio: number
}

export type EditFilter = AfftdnFilter | NotchFilter | HighpassFilter | AgateFilter

export type EditGain =
  | { mode: 'loudnorm'; targetLufs: number }
  /**
   * A single flat gain — unlike loudnorm, this never touches dynamics. The render computes a
   * baseline gain that lands the loudest sample at a fixed safe target (see PEAK_SAFE_TARGET_DB
   * server-side); `relativeDb` is the user's own adjustment on top of that baseline (0 = exactly
   * the calculated safe gain, positive pushes louder — and closer to clipping — from there).
   */
  | { mode: 'peak'; relativeDb: number }

export interface EditList {
  segments: EditSegment[]
  filters: EditFilter[]
  gain?: EditGain
  fades?: { inMs: number; outMs: number }
}

export interface NoiseRegion {
  start: number
  end: number
}

export interface KeepRange {
  start: number
  end: number
}

/**
 * The literal state of the editor's controls at last Save — crop selection and which takes are
 * turned on — kept separate from `EditList` so re-opening the editor can restore "what you had
 * before Save" against the full original recording, not just what got rendered.
 */
export interface EditSettings {
  keepRanges: KeepRange[]
  enabledTakeIds: string[]
}

export interface PeaksData {
  version: 1
  sampleRate: number
  samplesPerPixel: number
  length: number
  bits: 8
  channels: number
  data: number[] // interleaved min/max pairs per channel
}

export type UserRole = 'admin' | 'user'
export type UserStatus = 'pending' | 'approved' | 'rejected'

export const PENDING_SONG_LIMIT = 10
export const PENDING_SONG_WARNING_THRESHOLD = 8

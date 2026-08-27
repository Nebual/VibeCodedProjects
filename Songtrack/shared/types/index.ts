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

/**
 * The gain a song starts with when nobody has chosen one yet.
 *
 * The editor has always shown "Boost to peak" as the selection for a song with no stored `gain`
 * (see NoisePanel) and materializes it on mount — so merely opening the editor was enough to make a
 * quiet song play at a normal level. The master rendered at ingest never passes through the editor,
 * so it starts from this same default; otherwise the Song List plays a song quieter than the editor
 * does, for no reason the user can see.
 *
 * "Boost to peak" rather than "Normalize level": it's a single flat gain that never touches
 * dynamics, making it the safe one to apply before anyone has listened to the recording.
 */
export const DEFAULT_EDIT_GAIN = { mode: 'peak', relativeDb: 0 } as const satisfies EditGain

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

// ---------------------------------------------------------------------------
// Audio → MIDI transcription
// ---------------------------------------------------------------------------

/**
 * The metrical grid a transcription is barred against. MuScriptor detects one via
 * `beat-this`; the user can correct it in the tempo editor without re-running the model.
 *
 * The wire format from the sidecar is snake_case and carries no `subdivision` — the proxy
 * converts once, at the point the row is written, and everything downstream of
 * `server/utils/midiWorker.ts` speaks camelCase only.
 */
export interface BeatGrid {
  bpm: number
  beatsPerBar: number
  /** Seconds into the piece at which bar 1 beat 1 lands. May be > 0 (pickup bar). */
  firstDownbeat: number
  /** Seconds of streaming lag already removed from the final MIDI. Informational. */
  onsetDelay: number
  /** Finest notated division of a beat the grid admits: 2 = 8ths, 4 = 16ths, 3 = 8th triplets. */
  subdivision: number
  /**
   * Where this grid came from, so the UI can be honest about how much to trust it.
   * Optional because rows written before it existed simply don't carry it.
   *
   * - `detected` — the sidecar's beat tracker fitted a constant tempo and stood by it.
   * - `estimated` — a best guess: either the tempo upstream fitted and then *rejected* as too
   *   irregular, or our own autocorrelation over the onsets. Good enough to start from.
   * - `user` — supplied from the tempo editor. Never second-guess it.
   */
  source?: 'detected' | 'estimated' | 'user'
}

export const DEFAULT_SUBDIVISION = 4
export const BEATS_PER_BAR_CHOICES = [2, 3, 4, 6] as const

/** One transcribed note. Velocity is not recovered by the tokenizer — don't rely on it. */
export interface TranscribedNote {
  pitch: number
  start: number
  end: number
  instrument: string
}

// --- The sidecar's SSE frames. One JSON object per `data:` line. ---

export interface ProgressEvent {
  type: 'progress'
  completed: number
  total: number
}

export interface NoteStartEvent {
  type: 'start'
  pitch: number
  start_time: number
  index: number
  instrument: string
}

export interface NoteEndEvent {
  type: 'end'
  end_time: number
  start_event_index: number
}

/**
 * Raw wire shape of the beat grid — snake_case, no subdivision.
 *
 * Verified against a live muscriptor sidecar: `beats_per_bar` comes back **null** even when a
 * tempo *is* detected (observed `{bpm: 120.000…, beats_per_bar: null, first_downbeat: 0.0}`), so
 * it must be defaulted rather than trusted. `beatGridFromWire` is the single place that happens.
 */
export interface WireBeatGrid {
  bpm: number | null
  beats_per_bar: number | null
  first_downbeat: number | null
  onset_delay: number | null
}

/**
 * A tempo that was fitted but rejected as not constant enough.
 *
 * Only present on a sidecar carrying `patches/0001-mscz-export-and-tempo-hint.patch`. Stock
 * upstream raises `BeatDetectionError` and the fitted BPM survives only inside the exception's
 * message text, so a recording with any rubato at all yields a bare `beat_grid: null` and the UI
 * has nothing better than a 120 placeholder to offer.
 */
export interface WireTempoHint {
  bpm: number
  residual_ms: number | null
  reason: string
}

export interface TranscriptionCompleteEvent {
  type: 'transcription_complete'
  /** base64 .mid — the de-lagged performance MIDI. This is the file to save. */
  data: string
  /**
   * base64 .mid snapped to the detected grid. Optional: a live 0.3.0 sidecar omits the key
   * entirely rather than sending null, so never index it without a guard. Songtrack re-quantizes
   * from `events.json` anyway, so nothing depends on it.
   */
  quantized_midi?: string | null
  beat_grid?: WireBeatGrid | null
  tempo_hint?: WireTempoHint | null
}

export interface TranscriptionErrorEvent {
  type: 'error'
  message: string
}

export type TranscriptionEvent =
  | ProgressEvent
  | NoteStartEvent
  | NoteEndEvent
  | TranscriptionCompleteEvent
  | TranscriptionErrorEvent

/** Shape of `events.json` on disk: enough to re-quantize without re-running the model. */
export interface TranscriptionEvents {
  version: 1
  notes: TranscribedNote[]
}

/** What `GET /api/songs/:id/transcription` returns for an already-transcribed song. */
export interface TranscriptionSummary {
  id: string
  specHash: string
  model: string
  instruments: string[]
  beatGrid: BeatGrid | null
  hasPreview: boolean
  createdAt: number
}

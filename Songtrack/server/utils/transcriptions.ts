import { createHash } from 'node:crypto'
import type {
  BeatGrid,
  NoteEndEvent,
  NoteStartEvent,
  TranscribedNote,
  TranscriptionEvent,
  WireBeatGrid,
} from '../../shared/types'
import { DEFAULT_SUBDIVISION } from '../../shared/types'

/**
 * Identifies one transcription run. Instruments are sorted so that ['drums','piano'] and
 * ['piano','drums'] share a cache entry — the model doesn't care about request order and
 * neither should the cache.
 */
export function transcriptionSpecHash(
  masterPath: string,
  mtimeMs: number,
  model: string,
  instruments: string[],
): string {
  const key = `${masterPath}:${mtimeMs}:${model}:${[...instruments].sort().join(',')}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * Identifies one engraving of a transcription. Rounded before hashing so float noise in a
 * dragged BPM slider can't produce thousands of near-identical cached zips.
 */
export function gridHash(grid: BeatGrid): string {
  const key = [
    grid.bpm.toFixed(3),
    grid.beatsPerBar,
    grid.firstDownbeat.toFixed(4),
    grid.subdivision,
  ].join(':')
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

/**
 * The sidecar speaks snake_case and has no concept of a subdivision; we do. Convert exactly
 * once, here, so nothing downstream has to know the wire format exists.
 */
export function beatGridFromWire(wire: WireBeatGrid | null | undefined): BeatGrid | null {
  // No usable tempo means no grid at all — the caller falls back to unquantized output and says so.
  if (!wire || typeof wire.bpm !== 'number' || !Number.isFinite(wire.bpm) || wire.bpm <= 0) return null
  return {
    // Round away the detector's float noise: it reports e.g. 120.00000000000003, which shows up
    // in the BPM field as "120.000000…", writes a 120.00024 bpm tempo event into the score MIDI,
    // and would give two identical-looking grids different gridHashes.
    bpm: Math.round(wire.bpm * 1000) / 1000,
    // A live sidecar returns null here even alongside a perfectly good bpm, and a null would
    // reach the score writer as a `[null, 4]` time signature and the roll as a NaN bar width.
    // 4/4 is the right default: it's what MuseScore assumes on import regardless.
    beatsPerBar: typeof wire.beats_per_bar === 'number' && wire.beats_per_bar > 0
      ? wire.beats_per_bar
      : 4,
    firstDownbeat: typeof wire.first_downbeat === 'number' ? wire.first_downbeat : 0,
    onsetDelay: typeof wire.onset_delay === 'number' ? wire.onset_delay : 0,
    subdivision: DEFAULT_SUBDIVISION,
    source: 'detected',
  }
}

/**
 * Incremental SSE frame parser.
 *
 * A chunked HTTP body splits `data:` lines at arbitrary byte offsets, so a naive
 * `chunk.split('\n')` drops or corrupts whichever frame straddles a chunk boundary — a bug that
 * only ever surfaces on long transcriptions, which is exactly when it costs the most. Feed every
 * chunk through one instance of this and it holds the partial tail until the rest arrives.
 */
export class SseParser {
  private buffer = ''

  /** Returns every complete event in `chunk` (plus any completed by it), in order. */
  push(chunk: string): TranscriptionEvent[] {
    this.buffer += chunk
    const events: TranscriptionEvent[] = []

    // Frames are separated by a blank line, but the sidecar emits one `data:` line per frame,
    // so a lone newline terminates a frame too. Splitting on single newlines handles both:
    // the blank line between frames simply yields an empty segment, which is skipped.
    let newlineAt: number
    while ((newlineAt = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineAt).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newlineAt + 1)
      const event = parseSseLine(line)
      if (event) events.push(event)
    }
    return events
  }

  /** Anything still buffered after the stream ends — a final frame with no trailing newline. */
  flush(): TranscriptionEvent[] {
    const rest = this.buffer
    this.buffer = ''
    const event = parseSseLine(rest.replace(/\r$/, ''))
    return event ? [event] : []
  }
}

/** One SSE line → one event, or null for blanks, comments, and non-`data:` fields. */
function parseSseLine(line: string): TranscriptionEvent | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    const parsed = JSON.parse(payload)
    return typeof parsed?.type === 'string' ? parsed as TranscriptionEvent : null
  }
  catch {
    // A malformed frame is the sidecar's problem, not a reason to tear down a
    // transcription that is otherwise streaming fine.
    return null
  }
}

/**
 * Assembles notes from the streamed `start`/`end` frames.
 *
 * This is the *fallback* for when the final MIDI can't be parsed — `notesFromMidi` is the normal
 * path, because the streamed times run up to ~25 ms late and the MIDI does not. `onsetDelay`
 * (from the beat grid) is subtracted here to approximate the same correction.
 *
 * Every `start` is matched by exactly one `end` carrying the same index. A `start` with no `end`
 * means the stream was cut off mid-note; it is dropped rather than given an invented duration.
 */
export function notesFromEvents(
  starts: NoteStartEvent[],
  ends: NoteEndEvent[],
  onsetDelay = 0,
): TranscribedNote[] {
  const endByIndex = new Map<number, number>()
  for (const end of ends) endByIndex.set(end.start_event_index, end.end_time)

  const notes: TranscribedNote[] = []
  for (const start of starts) {
    const endTime = endByIndex.get(start.index)
    if (endTime === undefined) continue
    notes.push({
      pitch: start.pitch,
      start: Math.max(0, start.start_time - onsetDelay),
      end: Math.max(0, endTime - onsetDelay),
      instrument: start.instrument,
    })
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return notes
}

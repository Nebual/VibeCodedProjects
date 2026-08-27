import { existsSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../../database/client'
import { transcriptions } from '../../../database/schema'
import type {
  NoteEndEvent,
  NoteStartEvent,
  TranscribedNote,
  TranscriptionCompleteEvent,
  TranscriptionEvents,
} from '../../../../shared/types'

/**
 * Transcribes a song to MIDI, streaming the sidecar's Server-Sent Events straight through to the
 * browser. The HTTP request *is* the job — there is no queue, no jobs table and nothing to poll.
 *
 * Results are cached by spec hash exactly like `server/utils/renders.ts`: hash the inputs, look
 * for a row, do the work only on a miss.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  if (!song.masterPath || !existsSync(song.masterPath)) {
    throw createError({ statusCode: 404, statusMessage: 'Audio is still processing' })
  }

  const body = await readBody<{ instruments?: string[], force?: boolean }>(event).catch(() => ({}))
  // No selection means auto-detect, which is a different cache key from any explicit choice.
  const instruments = Array.isArray(body?.instruments) ? body.instruments.filter(i => typeof i === 'string') : []
  const model = midiWorkerModel()

  const mtimeMs = statSync(song.masterPath).mtimeMs
  const specHash = transcriptionSpecHash(song.masterPath, mtimeMs, model, instruments)

  setHeader(event, 'Content-Type', 'text/event-stream')
  setHeader(event, 'Cache-Control', 'no-cache')
  setHeader(event, 'Connection', 'keep-alive')
  // nginx buffers proxied responses by default, which would hold the whole stream until it ends.
  setHeader(event, 'X-Accel-Buffering', 'no')

  // `force` re-runs the model over inputs that are already cached. Without it, asking to
  // transcribe again with an unchanged instrument selection is a silent no-op that looks like a
  // broken button — and there is no other way to pick up a better model or a fixed upstream.
  const existing = body?.force
    ? undefined
    : db.select().from(transcriptions)
        .where(and(eq(transcriptions.songId, song.id), eq(transcriptions.specHash, specHash)))
        .get()

  if (existing && existsSync(existing.midiPath)) {
    // A cache hit has no note events to replay, so the client is handed the same
    // `transcription_complete` frame a live run ends with and needs no special case for
    // "already done" — it draws the finished roll from the decoded MIDI either way.
    const midi = await readFile(existing.midiPath)
    const frame: TranscriptionCompleteEvent = {
      type: 'transcription_complete',
      data: midi.toString('base64'),
      quantized_midi: null,
      beat_grid: existing.beatGrid
        ? {
            bpm: existing.beatGrid.bpm,
            beats_per_bar: existing.beatGrid.beatsPerBar,
            first_downbeat: existing.beatGrid.firstDownbeat,
            onset_delay: existing.beatGrid.onsetDelay,
          }
        : null,
    }
    return sseBody([
      { type: 'progress', completed: 1, total: 1 },
      frame,
    ])
  }

  // A stable per-tab id: upstream cancels a same-client resubmit at the next chunk boundary,
  // which is what makes double-clicking Start do the right thing. It deliberately cannot
  // preempt a different browser's run.
  const clientId = getHeader(event, 'x-client-id') || `${actor.user.id}:${song.id}`

  // If the browser goes away mid-transcription there is no point finishing the upload.
  const abort = new AbortController()
  event.node?.req?.on?.('close', () => abort.abort())

  const upstream = await postAudio(song.masterPath, { instruments, clientId, signal: abort.signal })
  if (!upstream.body) {
    throw createError({ statusCode: 502, statusMessage: 'Transcription worker returned an empty stream' })
  }

  const dir = transcriptionDir(actor.user.id, song.id, specHash)
  const midiPath = join(dir, 'transcription.mid')
  const eventsPath = join(dir, 'events.json')

  const parser = new SseParser()
  const starts: NoteStartEvent[] = []
  const ends: NoteEndEvent[] = []
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  /** Writes the MIDI, the events and the row. Must complete before the final frame is forwarded. */
  async function persist(frame: TranscriptionCompleteEvent) {
    const midi = Buffer.from(frame.data, 'base64')

    let notes: TranscribedNote[]
    try {
      notes = notesFromMidi(midi)
    }
    catch {
      // The file is what the client will play regardless; falling back keeps the
      // re-quantization path alive rather than losing the whole run to a parse error.
      notes = notesFromEvents(starts, ends, grid?.onsetDelay ?? 0)
    }

    // Best grid available, in descending order of trust:
    //  1. What the sidecar's beat tracker detected and stood by.
    //  2. The tempo it fitted and then rejected as too irregular — only reachable on a patched
    //     sidecar, which is most of why we carry the patch. A rubato recording lands here, and
    //     a rough tempo is worth far more than a 120 placeholder that is right by accident only.
    //  3. Our own autocorrelation over the transcribed onsets, for an unpatched sidecar.
    const grid = beatGridFromWire(frame.beat_grid)
      ?? estimateBeatGrid(notes, frame.tempo_hint?.bpm)
      ?? estimateBeatGrid(notes)

    const payload: TranscriptionEvents = { version: 1, notes }
    await writeFile(midiPath, midi)
    await writeFile(eventsPath, JSON.stringify(payload))

    db.insert(transcriptions).values({
      id: nanoid(),
      songId: song.id,
      specHash,
      model,
      instruments,
      midiPath,
      eventsPath,
      previewPath: null,
      beatGrid: grid,
      createdAt: new Date(),
    }).onConflictDoUpdate({
      // A forced re-run has to replace what's stored, not quietly keep the old grid — the point
      // of forcing is that the previous result was unsatisfactory. Paths are content-addressed
      // by spec hash, so the files have already been overwritten in place above.
      target: [transcriptions.songId, transcriptions.specHash],
      set: { beatGrid: grid, model, instruments, midiPath, eventsPath, createdAt: new Date() },
    }).run()

    recordAuditIfImpersonating(actor, 'song.transcribe', song.id)
  }

  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          // Parse before forwarding: the chunk carrying `transcription_complete` is held until
          // the files and the row are on disk, so a client that immediately requests a download
          // can't lose the race.
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            if (frame.type === 'start') starts.push(frame)
            else if (frame.type === 'end') ends.push(frame)
            else if (frame.type === 'transcription_complete') await persist(frame)
          }
          controller.enqueue(value)
        }
        for (const frame of parser.flush()) {
          if (frame.type === 'transcription_complete') await persist(frame)
        }
      }
      catch (err) {
        // The response has already begun, so an h3 error can't be thrown any more —
        // the only way to tell the page is an error frame it already knows how to render.
        const message = err instanceof Error ? err.message : 'Transcription failed'
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message })}\n\n`))
      }
      finally {
        reader.releaseLock()
        controller.close()
      }
    },
    cancel() {
      abort.abort()
    },
  })

  return out
})

/** A complete, already-finished SSE body — used for the cache-hit path. */
function sseBody(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      }
      controller.close()
    },
  })
}

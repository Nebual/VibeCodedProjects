import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { and, desc, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { db } from '../database/client'
import { transcriptions } from '../database/schema'
import type { BeatGrid, TranscribedNote, TranscriptionEvents } from '../../shared/types'
import { BEATS_PER_BAR_CHOICES, DEFAULT_SUBDIVISION } from '../../shared/types'

export type TranscriptionRow = typeof transcriptions.$inferSelect

/**
 * The transcription a request is about. `?spec=` pins a specific run; without it the most recent
 * one for the song wins, which is what the page always wants — it has just made it.
 */
export function loadTranscription(songId: string, specHash?: string): TranscriptionRow {
  const row = specHash
    ? db.select().from(transcriptions)
        .where(and(eq(transcriptions.songId, songId), eq(transcriptions.specHash, specHash)))
        .get()
    : db.select().from(transcriptions)
        .where(eq(transcriptions.songId, songId))
        .orderBy(desc(transcriptions.createdAt))
        .get()

  if (!row || !existsSync(row.midiPath)) {
    throw createError({ statusCode: 404, statusMessage: 'This song has not been transcribed yet.' })
  }
  return row
}

/** The saved note events — what makes re-quantizing at a corrected tempo arithmetic, not inference. */
export async function loadNotes(row: TranscriptionRow): Promise<TranscribedNote[]> {
  if (!existsSync(row.eventsPath)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This transcription is missing its note events — re-run the transcription.',
    })
  }
  const parsed = JSON.parse(await readFile(row.eventsPath, 'utf8')) as TranscriptionEvents
  return parsed.notes ?? []
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? n : null
}

/**
 * The beat grid a request should be engraved against: the user's corrections from the query
 * string, falling back per-field to what the model detected.
 *
 * Returns null only when nothing detected a grid *and* the user supplied no BPM — the caller then
 * has to fall back to unquantized output and say so.
 */
export function resolveGrid(event: H3Event, row: TranscriptionRow): BeatGrid | null {
  const q = getQuery(event)
  const stored = row.beatGrid

  const bpm = num(q.bpm) ?? stored?.bpm ?? null
  if (bpm === null) return null
  if (bpm <= 0 || bpm > 400) {
    throw createError({ statusCode: 400, statusMessage: `Implausible tempo: ${bpm} bpm` })
  }

  const beatsPerBar = num(q.beatsPerBar) ?? stored?.beatsPerBar ?? 4
  if (!BEATS_PER_BAR_CHOICES.includes(beatsPerBar as typeof BEATS_PER_BAR_CHOICES[number])) {
    throw createError({ statusCode: 400, statusMessage: `Unsupported beats per bar: ${beatsPerBar}` })
  }

  const firstDownbeat = num(q.firstDownbeat) ?? stored?.firstDownbeat ?? 0
  if (firstDownbeat < 0) {
    throw createError({ statusCode: 400, statusMessage: 'First downbeat cannot be negative' })
  }

  const subdivision = num(q.subdivision) ?? stored?.subdivision ?? DEFAULT_SUBDIVISION
  if (![2, 3, 4, 8].includes(subdivision)) {
    throw createError({ statusCode: 400, statusMessage: `Unsupported subdivision: ${subdivision}` })
  }

  return { bpm, beatsPerBar, firstDownbeat, onsetDelay: stored?.onsetDelay ?? 0, subdivision }
}

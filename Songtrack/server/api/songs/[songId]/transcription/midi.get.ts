import { readFile } from 'node:fs/promises'

/**
 * The two downloads, and they are never offered unlabelled:
 *
 * - `performance` — the de-lagged MIDI as transcribed. Sounds like the recording; the one to
 *   take into a DAW or just listen to.
 * - `score` — re-quantized onto the beat grid. The one to import into notation software.
 *
 * Handing someone the performance MIDI and letting them import *that* is the single most common
 * way this feature disappoints: notation software has to give every onset a notated duration, and
 * an onset 30 ms off the beat has no clean one — so it comes out as tied 128th notes and spurious
 * triplets. The transcription was fine; the file was the wrong one of the two.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  const q = getQuery(event)
  const variant = q.variant === 'score' ? 'score' : 'performance'
  const row = loadTranscription(song.id, q.spec as string | undefined)

  setHeader(event, 'Content-Type', 'audio/midi')

  if (variant === 'performance') {
    setHeader(event, 'Content-Disposition',
      `attachment; filename="${slugify(song.title)}-performance.mid"`)
    return streamRangeableFile(event, row.midiPath, 'audio/midi')
  }

  const grid = resolveGrid(event, row)
  if (!grid) {
    throw createError({
      statusCode: 409,
      statusMessage: 'No tempo is set for this transcription — set one in the tempo editor, '
        + 'or download the performance MIDI instead.',
    })
  }

  const notes = quantizeNotes(await loadNotes(row), grid)
  setHeader(event, 'Content-Disposition', `attachment; filename="${slugify(song.title)}-score.mid"`)
  return writeScoreMidi(notes, grid)
})

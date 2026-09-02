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
  const exclude = new Set(
    typeof q.exclude === 'string' ? q.exclude.split(',').map(s => s.trim()).filter(Boolean) : [],
  )

  setHeader(event, 'Content-Type', 'audio/midi')

  if (variant === 'performance') {
    setHeader(event, 'Content-Disposition',
      `attachment; filename="${slugify(song.title)}-performance.mid"`)
    // Nothing excluded is the common case, so it keeps streaming the sidecar's own file rather
    // than rebuilding an equivalent one from the saved notes.
    if (exclude.size === 0) return streamRangeableFile(event, row.midiPath, 'audio/midi')
    const notes = (await loadNotes(row)).filter(n => !exclude.has(n.instrument))
    return writePerformanceMidi(notes)
  }

  const grid = resolveGrid(event, row)
  if (!grid) {
    throw createError({
      statusCode: 409,
      statusMessage: 'No tempo is set for this transcription — set one in the tempo editor, '
        + 'or download the performance MIDI instead.',
    })
  }

  const notes = quantizeNotes((await loadNotes(row)).filter(n => !exclude.has(n.instrument)), grid)
  setHeader(event, 'Content-Disposition', `attachment; filename="${slugify(song.title)}-score.mid"`)
  return writeScoreMidi(notes, grid)
})

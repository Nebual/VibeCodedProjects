import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Engraves the transcription and returns the archive MuseScore produced.
 *
 * The archive is ZIP_STORED and contains `score.mid`, `score.musicxml`, `full_score.pdf`, one PDF
 * per instrument, and a tablature PDF for any guitar or bass part. It's unzipped client-side with
 * `fflate` and the files offered individually — one round trip, because MuseScore is slow.
 *
 * Sheets depend on a beat grid the user can change, so they can't live in a column: they're
 * content-addressed on disk as `sheets-<gridHash>.zip` and their existence is the cache check.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  const row = loadTranscription(song.id, getQuery(event).spec as string | undefined)
  const grid = resolveGrid(event, row)
  const dir = transcriptionDir(actor.user.id, song.id, row.specHash)

  setHeader(event, 'Content-Type', 'application/zip')
  setHeader(event, 'Content-Disposition', `attachment; filename="${slugify(song.title)}-sheets.zip"`)

  // No grid at all and none supplied: send the performance MIDI unquantized rather than refusing.
  // The notation will be rough, and the page says so — but a rough score beats no score.
  if (!grid) {
    const unquantizedPath = join(dir, 'sheets-unquantized.zip')
    if (existsSync(unquantizedPath)) return streamRangeableFile(event, unquantizedPath, 'application/zip')

    const zip = await postSheets(await readFile(row.midiPath), false)
    await writeFile(unquantizedPath, zip)
    return zip
  }

  const cachePath = join(dir, `sheets-${gridHash(grid)}.zip`)
  if (existsSync(cachePath)) return streamRangeableFile(event, cachePath, 'application/zip')

  const notes = quantizeNotes(await loadNotes(row), grid)
  // `quantized=true` matters more than it looks: it tells MuseScore's importer the notes are
  // already on a grid, so it doesn't layer its own quantization heuristics on top of ours.
  // Sending snapped MIDI with quantized=false gives the worst of both.
  const zip = await postSheets(writeScoreMidi(notes, grid), true)
  await writeFile(cachePath, zip)
  return zip
})

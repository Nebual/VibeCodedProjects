import { existsSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../../../../database/client'
import { transcriptions } from '../../../../database/schema'

/**
 * An audio check of the transcription. `mix` puts the original recording in the left ear and the
 * synthesised transcription in the right, which is the comparison you actually want; `synth` gives
 * the transcription alone.
 *
 * This is deliberately built from the *performance* MIDI, not the quantized one — the point is to
 * hear whether the notes are right, and quantizing would change the timing being checked. That
 * also makes it grid-independent, which is why it can cache in a column.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  const q = getQuery(event)
  const mode = q.mode === 'synth' ? 'synth' : 'mix'
  const row = loadTranscription(song.id, q.spec as string | undefined)

  if (mode === 'mix' && row.previewPath && existsSync(row.previewPath)) {
    return streamRangeableFile(event, row.previewPath, 'audio/ogg')
  }

  const wav = await postAuralize(
    await readFile(row.midiPath),
    mode === 'mix' ? song.masterPath : null,
    mode,
  )

  // Upstream returns WAV; re-encode to ogg to match this app's master.ogg convention rather than
  // shipping the browser a file several times the size.
  const dir = transcriptionDir(actor.user.id, song.id, row.specHash)
  const wavPath = join(dir, `preview-${mode}.wav`)
  const oggPath = join(dir, `preview-${mode}.ogg`)
  await writeFile(wavPath, wav)
  await runFfmpeg(['-y', '-i', wavPath, '-c:a', 'libvorbis', '-q:a', '5', oggPath])
  await unlink(wavPath).catch(() => {})

  if (mode === 'mix') {
    db.update(transcriptions).set({ previewPath: oggPath })
      .where(eq(transcriptions.id, row.id)).run()
  }

  return streamRangeableFile(event, oggPath, 'audio/ogg')
})

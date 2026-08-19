import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../database/client'
import { renders } from '../database/schema'

/**
 * `master.ogg` already has the song's edit list (segments/filters) baked in,
 * so an ogg download is just that file. mp3 needs a transcode, cached by a
 * hash of the master's mtime so an unchanged song never re-encodes twice.
 */
export async function getOrRenderDownload(
  song: { id: string, title: string, masterPath: string | null },
  format: 'mp3' | 'ogg',
): Promise<string> {
  if (!song.masterPath) {
    throw createError({ statusCode: 404, statusMessage: 'Audio is still processing' })
  }
  if (format === 'ogg') return song.masterPath

  const mtimeMs = statSync(song.masterPath).mtimeMs
  const specHash = createHash('sha256').update(`${song.masterPath}:${mtimeMs}`).digest('hex').slice(0, 16)

  const existing = db.select().from(renders)
    .where(and(eq(renders.songId, song.id), eq(renders.specHash, specHash), eq(renders.format, format)))
    .get()
  if (existing) return existing.path

  const outPath = join(rendersDir(), `${song.id}-${specHash}.${format}`)
  await runFfmpeg(['-i', song.masterPath, '-c:a', 'libmp3lame', '-q:a', '0', outPath])

  db.insert(renders).values({
    id: nanoid(),
    songId: song.id,
    specHash,
    format,
    path: outPath,
    createdAt: new Date(),
  }).run()

  return outPath
}

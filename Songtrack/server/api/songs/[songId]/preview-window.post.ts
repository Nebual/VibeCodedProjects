import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  if (!song.masterPath) {
    throw createError({ statusCode: 404, statusMessage: 'Audio is still processing' })
  }

  const body = await readBody<{ center: number, padding?: number }>(event)
  const padding = body.padding ?? 3
  const start = Math.max(0, body.center - padding)
  const duration = padding * 2

  const outPath = join(rendersDir(), `previewwin-${songId}-${nanoid()}.ogg`)
  await runFfmpeg(['-ss', String(start), '-t', String(duration), '-i', song.masterPath, '-c:a', 'libopus', '-b:a', '192k', outPath])

  const buf = await readFile(outPath)
  await rm(outPath, { force: true })

  setHeader(event, 'Content-Type', 'audio/ogg')
  return buf
})

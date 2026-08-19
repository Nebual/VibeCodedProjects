import { readFile } from 'node:fs/promises'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  if (!song.peaksPath) {
    throw createError({ statusCode: 404, statusMessage: 'Peaks are still processing' })
  }

  return JSON.parse(await readFile(song.peaksPath, 'utf8'))
})

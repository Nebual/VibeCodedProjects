import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const takeId = getRouterParam(event, 'takeId')!
  getOwnedSong(actor.user.id, songId)

  const index = Number(getQuery(event).index)
  if (!Number.isInteger(index) || index < 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chunk index' })
  }

  const body = await readRawBody(event, false)
  if (!body) {
    throw createError({ statusCode: 400, statusMessage: 'Empty chunk' })
  }

  const dir = takeChunkDir(actor.user.id, songId, takeId)
  await writeFile(join(dir, `${String(index).padStart(6, '0')}.chunk`), body)

  return { ok: true }
})

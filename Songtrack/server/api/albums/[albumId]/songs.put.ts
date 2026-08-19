import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { albumSongs } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const albumId = getRouterParam(event, 'albumId')!
  getOwnedAlbum(actor.user.id, albumId)

  const body = await readBody<{ songIds: string[] }>(event)
  if (!Array.isArray(body?.songIds)) {
    throw createError({ statusCode: 400, statusMessage: 'songIds must be an array' })
  }

  // Songs must belong to the same user — reject cross-user injection attempts.
  for (const songId of body.songIds) {
    getOwnedSong(actor.user.id, songId)
  }

  db.delete(albumSongs).where(eq(albumSongs.albumId, albumId)).run()
  body.songIds.forEach((songId, position) => {
    db.insert(albumSongs).values({ albumId, songId, position }).run()
  })

  recordAuditIfImpersonating(actor, 'album.reorder', albumId)
  return { ok: true }
})

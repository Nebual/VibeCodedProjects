import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { albumSongs, albums } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const albumId = getRouterParam(event, 'albumId')!
  getOwnedAlbum(actor.user.id, albumId)

  db.delete(albumSongs).where(eq(albumSongs.albumId, albumId)).run()
  db.delete(albums).where(eq(albums.id, albumId)).run()

  recordAuditIfImpersonating(actor, 'album.delete', albumId)
  return { ok: true }
})

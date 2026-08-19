import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { albums } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const albumId = getRouterParam(event, 'albumId')!
  getOwnedAlbum(actor.user.id, albumId)

  db.update(albums).set({ shareToken: null }).where(eq(albums.id, albumId)).run()

  recordAuditIfImpersonating(actor, 'album.unshare', albumId)
  return { ok: true }
})

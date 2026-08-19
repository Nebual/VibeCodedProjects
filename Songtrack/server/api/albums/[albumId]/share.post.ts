import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../../database/client'
import { albums } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const albumId = getRouterParam(event, 'albumId')!
  const album = getOwnedAlbum(actor.user.id, albumId)

  let token = album.shareToken
  if (!token) {
    token = nanoid(16)
    db.update(albums).set({ shareToken: token }).where(eq(albums.id, albumId)).run()
  }

  recordAuditIfImpersonating(actor, 'album.share', albumId)
  return { token, slug: slugify(album.title) }
})

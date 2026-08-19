import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { albums } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const albumId = getRouterParam(event, 'albumId')!
  getOwnedAlbum(actor.user.id, albumId)

  const body = await readBody<{ title?: string, description?: string }>(event)
  const updates: Partial<typeof albums.$inferInsert> = {}
  if (body.title !== undefined) {
    const title = body.title.trim()
    if (!title) throw createError({ statusCode: 400, statusMessage: 'Title cannot be empty' })
    updates.title = title
    updates.slug = slugify(title)
  }
  if (body.description !== undefined) updates.description = body.description

  db.update(albums).set(updates).where(eq(albums.id, albumId)).run()

  recordAuditIfImpersonating(actor, 'album.update', albumId)
  return { ok: true }
})

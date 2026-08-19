import { nanoid } from 'nanoid'
import { db } from '../../database/client'
import { albums } from '../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const body = await readBody<{ title?: string, description?: string }>(event)
  const title = body?.title?.trim()
  if (!title) {
    throw createError({ statusCode: 400, statusMessage: 'Title is required' })
  }

  const id = nanoid()
  db.insert(albums).values({
    id,
    userId: actor.user.id,
    title,
    slug: slugify(title),
    description: body?.description ?? null,
    createdAt: new Date(),
  }).run()

  recordAuditIfImpersonating(actor, 'album.create', id)
  return { id }
})

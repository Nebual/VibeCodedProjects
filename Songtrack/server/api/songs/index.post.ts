import { nanoid } from 'nanoid'
import { db } from '../../database/client'
import { songs } from '../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  assertCanCreateSong(actor.user)

  const body = await readBody<{ title?: string, tagNames?: string[] }>(event)
  const title = body?.title?.trim()
  if (!title) {
    throw createError({ statusCode: 400, statusMessage: 'Title is required' })
  }

  const now = new Date()
  const id = nanoid()
  db.insert(songs).values({
    id,
    userId: actor.user.id,
    title,
    slug: slugify(title),
    editList: { segments: [], filters: [] },
    createdAt: now,
    updatedAt: now,
  }).run()

  if (body?.tagNames?.length) {
    attachTagsToSong(actor.user.id, id, body.tagNames)
  }

  recordAuditIfImpersonating(actor, 'song.create', id)

  return { id }
})

import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { songs, songTags } from '../../../database/schema'

interface UpdateBody {
  title?: string
  description?: string
  musicKey?: string
  timeSignature?: string
  rating?: number
  externalUrl?: string
  tagNames?: string[]
}

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

  const body = await readBody<UpdateBody>(event)
  const updates: Partial<typeof songs.$inferInsert> = { updatedAt: new Date() }

  if (body.title !== undefined) {
    const title = body.title.trim()
    if (!title) throw createError({ statusCode: 400, statusMessage: 'Title cannot be empty' })
    updates.title = title
    updates.slug = slugify(title)
  }
  if (body.description !== undefined) updates.description = body.description
  if (body.musicKey !== undefined) updates.musicKey = body.musicKey
  if (body.timeSignature !== undefined) updates.timeSignature = body.timeSignature
  if (body.rating !== undefined) updates.rating = Math.max(0, Math.min(10, Math.round(body.rating)))
  if (body.externalUrl !== undefined) updates.externalUrl = body.externalUrl

  db.update(songs).set(updates).where(eq(songs.id, songId)).run()

  if (body.tagNames) {
    db.delete(songTags).where(eq(songTags.songId, songId)).run()
    attachTagsToSong(actor.user.id, songId, body.tagNames)
  }

  recordAuditIfImpersonating(actor, 'song.update', songId)
  return { ok: true }
})

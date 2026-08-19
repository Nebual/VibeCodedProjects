import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../database/client'
import { songs } from '../../database/schema'

interface BulkTagsBody {
  songIds: string[]
  tagNames: string[]
  mode: 'add' | 'remove'
}

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const body = await readBody<BulkTagsBody>(event)
  const songIds = body?.songIds?.filter(Boolean) ?? []
  const tagNames = body?.tagNames?.map(n => n.trim()).filter(Boolean) ?? []

  if (songIds.length === 0 || tagNames.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'songIds and tagNames are required' })
  }
  if (body.mode !== 'add' && body.mode !== 'remove') {
    throw createError({ statusCode: 400, statusMessage: 'mode must be "add" or "remove"' })
  }

  // A client-supplied selection may include ids the caller doesn't own (or
  // that no longer exist) — silently skip those rather than 404ing the whole
  // batch over one bad id.
  const owned = db.select({ id: songs.id }).from(songs)
    .where(and(eq(songs.userId, actor.user.id), inArray(songs.id, songIds)))
    .all()
    .map(s => s.id)

  for (const songId of owned) {
    if (body.mode === 'add') attachTagsToSong(actor.user.id, songId, tagNames)
    else detachTagsFromSong(actor.user.id, songId, tagNames)
  }

  recordAuditIfImpersonating(actor, `song.bulk-tag-${body.mode}`, `${owned.length} song(s): ${tagNames.join(', ')}`)
  return { updated: owned.length }
})

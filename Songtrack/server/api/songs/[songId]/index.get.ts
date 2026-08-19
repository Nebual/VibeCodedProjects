import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { songTags, tags } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  const tagRows = db.select({ name: tags.name })
    .from(songTags)
    .innerJoin(tags, eq(songTags.tagId, tags.id))
    .where(eq(songTags.songId, songId))
    .all()

  return { ...song, tags: tagRows.map(t => t.name) }
})

import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { songs, songTags, tags } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')!
  const song = db.select().from(songs).where(eq(songs.shareToken, token)).get()
  if (!song) {
    throw createError({ statusCode: 404, statusMessage: 'This link is no longer valid.' })
  }

  const tagRows = db.select({ name: tags.name })
    .from(songTags)
    .innerJoin(tags, eq(songTags.tagId, tags.id))
    .where(eq(songTags.songId, song.id))
    .all()

  return {
    id: song.id,
    title: song.title,
    description: song.description,
    musicKey: song.musicKey,
    timeSignature: song.timeSignature,
    rating: song.rating,
    externalUrl: song.externalUrl,
    durationS: song.durationS,
    tags: tagRows.map(t => t.name),
  }
})

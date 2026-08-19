import { eq } from 'drizzle-orm'
import { db } from '../../../../database/client'
import { songs } from '../../../../database/schema'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')!
  const song = db.select().from(songs).where(eq(songs.shareToken, token)).get()
  if (!song || !song.masterPath) {
    throw createError({ statusCode: 404, statusMessage: 'This link is no longer valid.' })
  }

  return streamRangeableFile(event, song.masterPath, 'audio/ogg')
})

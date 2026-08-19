import { and, eq } from 'drizzle-orm'
import { db } from '../../../../../../database/client'
import { albumSongs, albums, songs } from '../../../../../../database/schema'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')!
  const songId = getRouterParam(event, 'songId')!

  const album = db.select().from(albums).where(eq(albums.shareToken, token)).get()
  if (!album) {
    throw createError({ statusCode: 404, statusMessage: 'This link is no longer valid.' })
  }

  const membership = db.select().from(albumSongs)
    .where(and(eq(albumSongs.albumId, album.id), eq(albumSongs.songId, songId)))
    .get()
  if (!membership) {
    throw createError({ statusCode: 404, statusMessage: 'Song not found in this album.' })
  }

  const song = db.select().from(songs).where(eq(songs.id, songId)).get()
  if (!song?.masterPath) {
    throw createError({ statusCode: 404, statusMessage: 'Audio is still processing' })
  }

  return streamRangeableFile(event, song.masterPath, 'audio/ogg')
})

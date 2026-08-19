import { asc, eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { albumSongs, albums, songs } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')!
  const album = db.select().from(albums).where(eq(albums.shareToken, token)).get()
  if (!album) {
    throw createError({ statusCode: 404, statusMessage: 'This link is no longer valid.' })
  }

  const rows = db.select({ song: songs, position: albumSongs.position })
    .from(albumSongs)
    .innerJoin(songs, eq(albumSongs.songId, songs.id))
    .where(eq(albumSongs.albumId, album.id))
    .orderBy(asc(albumSongs.position))
    .all()

  return {
    title: album.title,
    description: album.description,
    songs: rows.map(r => ({ id: r.song.id, title: r.song.title, durationS: r.song.durationS })),
  }
})

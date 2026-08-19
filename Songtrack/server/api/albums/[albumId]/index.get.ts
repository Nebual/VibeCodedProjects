import { asc, eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { albumSongs, songs } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const albumId = getRouterParam(event, 'albumId')!
  const album = getOwnedAlbum(actor.user.id, albumId)

  const rows = db.select({ song: songs, position: albumSongs.position })
    .from(albumSongs)
    .innerJoin(songs, eq(albumSongs.songId, songs.id))
    .where(eq(albumSongs.albumId, albumId))
    .orderBy(asc(albumSongs.position))
    .all()

  return {
    ...album,
    songs: rows.map(r => ({
      id: r.song.id,
      title: r.song.title,
      durationS: r.song.durationS,
      rating: r.song.rating,
      position: r.position,
    })),
  }
})

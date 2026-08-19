import { eq } from 'drizzle-orm'
import { db } from '../database/client'
import { albums } from '../database/schema'

export function getOwnedAlbum(userId: string, albumId: string) {
  const album = db.select().from(albums).where(eq(albums.id, albumId)).get()
  if (!album || album.userId !== userId) {
    throw createError({ statusCode: 404, statusMessage: 'Album not found' })
  }
  return album
}

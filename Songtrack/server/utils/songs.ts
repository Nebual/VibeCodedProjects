import { count, eq } from 'drizzle-orm'
import { db } from '../database/client'
import { songs } from '../database/schema'
import type { AuthedUser } from './auth'
import { PENDING_SONG_LIMIT } from '#shared/types'

/** Pending accounts can try the app immediately, capped so an open box can't be abused before approval. */
export function assertCanCreateSong(user: AuthedUser) {
  if (user.status !== 'pending') return
  const row = db.select({ n: count() }).from(songs).where(eq(songs.userId, user.id)).get()
  if ((row?.n ?? 0) >= PENDING_SONG_LIMIT) {
    throw createError({
      statusCode: 403,
      statusMessage: `Awaiting admin approval — pending accounts are limited to ${PENDING_SONG_LIMIT} songs.`,
    })
  }
}

export function getOwnedSong(userId: string, songId: string) {
  const song = db.select().from(songs).where(eq(songs.id, songId)).get()
  if (!song || song.userId !== userId) {
    throw createError({ statusCode: 404, statusMessage: 'Song not found' })
  }
  return song
}

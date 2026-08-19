import { rm } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { renders, songs, songTags, takes } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

  db.delete(songTags).where(eq(songTags.songId, songId)).run()
  db.delete(takes).where(eq(takes.songId, songId)).run()
  db.delete(renders).where(eq(renders.songId, songId)).run()
  db.delete(songs).where(eq(songs.id, songId)).run()

  await rm(songDir(actor.user.id, songId), { recursive: true, force: true })

  recordAuditIfImpersonating(actor, 'song.delete', songId)
  return { ok: true }
})

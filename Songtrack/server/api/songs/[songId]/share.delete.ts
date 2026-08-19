import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { songs } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

  db.update(songs).set({ shareToken: null }).where(eq(songs.id, songId)).run()

  recordAuditIfImpersonating(actor, 'song.unshare', songId)
  return { ok: true }
})

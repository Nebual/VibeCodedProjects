import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../../database/client'
import { songs } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  let token = song.shareToken
  if (!token) {
    token = nanoid(16)
    db.update(songs).set({ shareToken: token }).where(eq(songs.id, songId)).run()
  }

  recordAuditIfImpersonating(actor, 'song.share', songId)
  return { token, slug: slugify(song.title) }
})

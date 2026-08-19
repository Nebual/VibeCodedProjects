import { asc, eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { takes } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

  const rows = db.select().from(takes).where(eq(takes.songId, songId)).orderBy(asc(takes.ordinal)).all()
  return rows.map(t => ({
    id: t.id,
    timelineStart: t.timelineStart,
    durationS: t.durationS,
    ordinal: t.ordinal,
    createdAt: t.createdAt,
  }))
})

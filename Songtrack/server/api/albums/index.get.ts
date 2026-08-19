import { desc, eq } from 'drizzle-orm'
import { db } from '../../database/client'
import { albums } from '../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  return db.select().from(albums).where(eq(albums.userId, actor.user.id)).orderBy(desc(albums.createdAt)).all()
})

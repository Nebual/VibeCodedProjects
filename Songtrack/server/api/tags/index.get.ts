import { desc, eq } from 'drizzle-orm'
import { db } from '../../database/client'
import { tags } from '../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const rows = db.select().from(tags).where(eq(tags.userId, actor.user.id)).orderBy(desc(tags.lastUsedAt)).all()
  return rows.map(t => ({ id: t.id, name: t.name }))
})

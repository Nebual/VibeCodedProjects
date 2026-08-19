import { eq } from 'drizzle-orm'
import { db } from '../../../../database/client'
import { users } from '../../../../database/schema'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const userId = getRouterParam(event, 'userId')!

  db.update(users).set({ status: 'approved', approvedAt: new Date(), approvedBy: admin.id })
    .where(eq(users.id, userId)).run()

  return { ok: true }
})

import { eq } from 'drizzle-orm'
import { db } from '../../../../database/client'
import { users } from '../../../../database/schema'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const userId = getRouterParam(event, 'userId')!
  if (userId === admin.id) {
    throw createError({ statusCode: 400, statusMessage: "You can't reject your own account." })
  }

  db.update(users).set({ status: 'rejected' }).where(eq(users.id, userId)).run()
  return { ok: true }
})

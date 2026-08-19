import { eq } from 'drizzle-orm'
import { db } from '../../../../database/client'
import { users } from '../../../../database/schema'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const userId = getRouterParam(event, 'userId')!
  if (userId === admin.id) {
    throw createError({ statusCode: 400, statusMessage: "You can't revoke your own approval." })
  }

  // Back to pending (capped, not blocked) — distinct from a hard reject.
  db.update(users).set({ status: 'pending', approvedAt: null, approvedBy: null }).where(eq(users.id, userId)).run()
  return { ok: true }
})

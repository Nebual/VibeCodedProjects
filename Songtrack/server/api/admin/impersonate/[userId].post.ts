import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { users } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const userId = getRouterParam(event, 'userId')
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'Missing userId' })

  const target = db.select().from(users).where(eq(users.id, userId)).get()
  if (!target) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  await setUserSession(event, { impersonatingUserId: userId })
  return { ok: true, impersonating: { id: target.id, name: target.name, email: target.email } }
})

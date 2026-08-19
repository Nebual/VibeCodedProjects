import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../database/client'
import { users } from '../database/schema'

/**
 * Test-only login bypass for e2e specs — real Google OAuth can't be driven
 * headlessly. Inert unless ALLOW_TEST_LOGIN=true is explicitly set (the
 * Playwright config sets it for its own server only), so it can't be hit by
 * accident in a normal dev or production run.
 */
export default defineEventHandler(async (event) => {
  if (process.env.ALLOW_TEST_LOGIN !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  let user = db.select().from(users).where(eq(users.email, 'playwright-test@example.com')).get()
  if (!user) {
    const now = new Date()
    user = {
      id: nanoid(),
      googleSub: 'playwright-test-sub',
      email: 'playwright-test@example.com',
      name: 'Playwright Test',
      avatarUrl: null,
      role: 'user',
      status: 'approved',
      approvedAt: now,
      approvedBy: 'system',
      createdAt: now,
    }
    db.insert(users).values(user).run()
  }

  await setUserSession(event, {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      status: user.status,
    },
  })

  return { ok: true, userId: user.id }
})

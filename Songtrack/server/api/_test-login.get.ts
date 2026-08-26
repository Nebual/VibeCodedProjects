import { eq } from 'drizzle-orm'
import { db } from '../database/client'
import { users } from '../database/schema'

/**
 * Test-only login bypass for e2e specs — real Google OAuth can't be driven
 * headlessly. Inert unless ALLOW_TEST_LOGIN=true is explicitly set (the
 * Playwright config and the vitest e2e setup both set it for their own
 * servers only), so it can't be hit by accident in a normal dev or prod run.
 *
 * Accepts ?email=... to log in as an existing seeded account (used by the
 * API integration tests); without it, falls back to creating/reusing a
 * generic Playwright user.
 */
export default defineEventHandler(async (event) => {
  if (process.env.ALLOW_TEST_LOGIN !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const { email } = getQuery(event)
  const targetEmail = typeof email === 'string' && email ? email : 'playwright-test@example.com'

  const user = db.select().from(users).where(eq(users.email, targetEmail)).get()
  if (!user) {
    throw createError({ statusCode: 404, statusMessage: `No such user: ${targetEmail}` })
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

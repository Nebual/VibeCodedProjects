/**
 * Development-only sign-in.
 *
 * Lets the app be worked on without Google OAuth credentials. Deliberately
 * double-gated: it 404s unless the server is running in dev mode *and*
 * FITTOWN_DEV_LOGIN=1 is set explicitly, so it cannot be reached in a
 * production build even if the env var leaks into the deployment.
 */
export default defineEventHandler(async (event) => {
  if (!import.meta.dev || process.env.FITTOWN_DEV_LOGIN !== '1') {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const body = await readBody<{ email?: string; name?: string }>(event).catch(() => ({}))
  const email = (body?.email || 'dev@fittown.local').toLowerCase()
  const name = body?.name || 'Dev User'

  const dbUser = upsertGoogleUser({
    // Namespaced so a dev row can never collide with a real Google subject.
    sub: `dev:${email}`,
    email,
    name,
  })

  await setUserSession(event, {
    user: {
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      avatar: null,
    },
    loggedInAt: new Date().toISOString(),
  })

  return { ok: true }
})

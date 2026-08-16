/**
 * Google OAuth callback. nuxt-auth-utils handles the redirect dance; we just
 * map the verified Google profile onto a local user row and open a session.
 */
export default defineOAuthGoogleEventHandler({
  config: {
    scope: ['openid', 'email', 'profile'],
  },

  async onSuccess(event, { user }) {
    if (!user?.email) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Google account did not return an email address',
      })
    }

    // Only let people in with a verified address — an unverified one proves
    // nothing about who owns it.
    if (user.email_verified === false) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Please verify your Google email address first',
      })
    }

    const allowed = allowedEmails()
    if (allowed && !allowed.has(user.email.toLowerCase())) {
      throw createError({
        statusCode: 403,
        statusMessage: 'This account is not on the allow-list for this Fittown instance',
      })
    }

    const dbUser = upsertGoogleUser({
      sub: user.sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
    })

    await setUserSession(event, {
      user: {
        id: dbUser.id,
        name: dbUser.name,
        email: dbUser.email,
        avatar: dbUser.avatar_url,
      },
      loggedInAt: new Date().toISOString(),
    })

    return sendRedirect(event, '/')
  },

  onError(event, error) {
    console.error('Google OAuth failed:', error)
    return sendRedirect(event, '/login?error=oauth')
  },
})

/**
 * Optional allow-list so a self-hosted instance exposed to the internet can't
 * be joined by anyone with a Google account. Set FITTOWN_ALLOWED_EMAILS to a
 * comma-separated list; leave unset to allow any Google user.
 */
function allowedEmails(): Set<string> | null {
  const raw = process.env.FITTOWN_ALLOWED_EMAILS?.trim()
  if (!raw) return null
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )
}

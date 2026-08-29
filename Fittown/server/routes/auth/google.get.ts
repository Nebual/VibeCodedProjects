import { createPairCode } from '../../utils/deviceAuth'

/**
 * Google OAuth callback. nuxt-auth-utils handles the redirect dance; we just
 * map the verified Google profile onto a local user row and open a session —
 * except when the request came from the phone app, where it hands back a
 * pairing code instead. See the comment on OAUTH_APP_COOKIE below for why.
 */
const googleOAuthHandler = defineOAuthGoogleEventHandler({
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

    // The phone app's own sign-in flow: mint a pairing code and hand it
    // straight to the app via the deep link, rather than opening a session
    // here. See the cookie's own comment for why this branch exists at all.
    if (getCookie(event, OAUTH_APP_COOKIE) === '1') {
      deleteCookie(event, OAUTH_APP_COOKIE)
      const { code } = createPairCode(useDb(), dbUser.id, 'Phone (Google sign-in)')
      return sendRedirect(event, `fittown://pair?code=${code}`)
    }

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
    deleteCookie(event, OAUTH_APP_COOKIE)
    // Shown inside the Chrome Custom Tab the app opened, not the app itself
    // — there is no session to hand back, so there is nowhere else useful to
    // send this. The user can just close the tab and retry from the app.
    return sendRedirect(event, '/login?error=oauth')
  },
})

/**
 * Marks an OAuth attempt as having started from the phone app rather than an
 * ordinary browser, so `onSuccess` knows to hand back a pairing code instead
 * of opening a session nobody is there to use.
 *
 * Why a cookie works here and a naive one wouldn't: the app's login button
 * (app/pages/login.vue) opens this whole flow — both this leg and the Google
 * redirect back to it — in one Chrome Custom Tab via `Browser.open()`, not
 * inside the WebView. That matters because a cookie set on this first leg
 * only survives to `onSuccess` if the *same* HTTP client makes both
 * requests. Starting the flow inside the WebView (a plain in-app link) and
 * letting Capacitor's default cross-origin handling pop the Google redirect
 * out to Chrome mid-flight — which is what happens if the app's own OAuth
 * link doesn't go through Browser.open() — puts the two legs in different
 * cookie jars: nuxt-auth-utils' own CSRF state cookie fails the same way,
 * which is the "state mismatch" this design exists to avoid, not just a
 * missing redirect back to the app.
 */
const OAUTH_APP_COOKIE = 'fittown_oauth_app'

export default defineEventHandler((event) => {
  // Only the first leg has no `code` yet — the callback shouldn't re-arm
  // this for a follow-up request.
  if (getQuery(event).client === 'app' && !getQuery(event).code) {
    setCookie(event, OAUTH_APP_COOKIE, '1', {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 600, // matches the pairing code's own 10-minute TTL
      path: '/',
    })
  }

  return googleOAuthHandler(event)
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

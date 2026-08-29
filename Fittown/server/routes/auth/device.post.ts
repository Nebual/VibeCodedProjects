import { requireDevice } from '../../utils/deviceAuth'

/**
 * Bootstrap a browser session for the Capacitor shell from a device token.
 *
 * Google OAuth refuses to run inside an Android WebView
 * (`disallowed_useragent`), so the phone app can't use /auth/google the way a
 * real browser does. Instead it already holds a device token — paired via
 * POST /api/devices/claim while the user was signed in on their phone's real
 * browser — and trades it here (`Authorization: Bearer <token>`) for the same
 * session cookie /auth/google would have set. See docs/samsung-health-sync.md
 * §3.
 */
export default defineEventHandler(async (event) => {
  const { user } = await requireDevice(event)

  await setUserSession(event, {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar_url,
    },
    loggedInAt: new Date().toISOString(),
  })

  return { ok: true }
})

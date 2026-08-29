import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Bootstrap a session inside the Capacitor shell (docs/samsung-health-sync.md
 * §3, §6). Google OAuth refuses to run inside a WebView
 * (`disallowed_useragent`), so the phone app can't reach /auth/google the way
 * a real browser does. Instead: on launch, if we're running natively and
 * don't already have a session, ask the native layer (DeviceTokenPlugin.kt)
 * for the token paired at Settings -> Connect a phone
 * (POST /api/devices/claim) and trade it in at POST /auth/device — the same
 * session cookie /auth/google would have set.
 *
 * A no-op in every ordinary browser: Capacitor.isNativePlatform() is false
 * there, so this plugin costs nothing beyond that one check.
 *
 * First-launch timing, worth knowing rather than discovering: the very first
 * cold launch right after pairing has no session cookie yet, so the global
 * auth middleware's server-side render shows /login before this plugin ever
 * runs. That's fine, not a bug — login.vue already has a `watchEffect` that
 * navigates away the instant `loggedIn` turns true, so once this plugin's
 * fetch resolves, the app bounces itself to `/` without anything extra here.
 * Every launch after the first reuses the WebView's persisted cookie and
 * never reaches this code path at all.
 */
interface DeviceTokenPlugin {
  getToken(): Promise<{ token: string | null }>
}

const DeviceToken = registerPlugin<DeviceTokenPlugin>('DeviceToken')

export default defineNuxtPlugin(() => {
  if (!Capacitor.isNativePlatform()) return

  onNuxtReady(async () => {
    const { loggedIn, fetch: refreshSession } = useUserSession()
    if (loggedIn.value) return

    const { token } = await DeviceToken.getToken()
    if (!token) return // Not paired yet — Settings walks the user through it.

    try {
      await $fetch('/auth/device', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      await refreshSession()
    } catch {
      // A revoked or invalid token. Surfacing this as something the user can
      // act on (re-pair from Settings) is Phase 5 polish, not this plugin's
      // job — the auth middleware already leaves them on /login regardless.
    }
  })
})

import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

/**
 * Two ways a device token turns into a session inside the Capacitor shell
 * (docs/samsung-health-sync.md §3, §6). Google OAuth refuses to run inside a
 * WebView (`disallowed_useragent`), so neither path goes through
 * /auth/google directly — see the comment on OAUTH_APP_COOKIE in
 * server/routes/auth/google.get.ts for how the sign-in button avoids that
 * while still ending up here.
 *
 * A no-op in every ordinary browser: Capacitor.isNativePlatform() is false
 * there, so this plugin costs nothing beyond that one check.
 */
export default defineNuxtPlugin(() => {
  if (!Capacitor.isNativePlatform()) return

  // 1. Already paired, cold launch: trade the stored token for a session
  // before the auth middleware ever gets a chance to redirect to /login.
  //
  // First-launch timing, worth knowing rather than discovering: the very
  // first cold launch right after pairing has no session cookie yet, so the
  // server-rendered response shows /login before this ever runs. That's
  // fine, not a bug — login.vue already has a `watchEffect` that navigates
  // away the instant `loggedIn` turns true, so once this resolves, the app
  // bounces itself to `/` without anything extra here. Every launch after
  // the first reuses the WebView's persisted cookie and never reaches this
  // code path at all.
  onNuxtReady(async () => {
    const { loggedIn } = useUserSession()
    if (loggedIn.value) return

    const { token } = await DeviceToken.getToken()
    if (!token) return // Not paired yet.

    try {
      await $fetch('/auth/device', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      await useUserSession().fetch()
    } catch {
      // Revoked or invalid — the auth middleware leaves the user on /login
      // regardless; Settings (Phase 5) is where they'd notice and re-pair.
    }
  })

  // 2. The pairing deep link, fittown://pair?code=XXXXXXXX — either tapped
  // by hand from a browser's "Connect a phone" screen, or arrived
  // automatically as the tail end of the app's own Google sign-in
  // (createPairCode() in server/utils/deviceAuth.ts). Route it through
  // /pair rather than claiming here directly, so there's exactly one place
  // (the page) that does the claim, whether the code was typed or handed to
  // us this way.
  App.addListener('appUrlOpen', ({ url }) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'fittown:' || parsed.hostname !== 'pair') return

    const code = parsed.searchParams.get('code')
    if (code) navigateTo({ path: '/pair', query: { code } })
  })
})

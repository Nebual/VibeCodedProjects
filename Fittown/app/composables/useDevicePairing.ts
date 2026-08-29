import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * The native token store (server/mobile/android/app/src/main/java/com/fittown/app/DeviceTokenPlugin.kt).
 * A no-op stub on any ordinary platform — Capacitor's web fallback throws
 * "not implemented" if a method is actually called, so callers here guard
 * every use with Capacitor.isNativePlatform().
 */
interface DeviceTokenPlugin {
  getToken(): Promise<{ token: string | null }>
  setToken(options: { token: string }): Promise<void>
}

export const DeviceToken = registerPlugin<DeviceTokenPlugin>('DeviceToken')

/**
 * Claim a pairing code (docs/samsung-health-sync.md §3) and open a session
 * from it. Shared by app/pages/pair.vue (typed in by hand, or arriving
 * pre-filled from a fittown://pair deep link) and
 * app/plugins/device-auth.client.ts (the same deep link caught while the app
 * is already running, mid-session).
 *
 * On native, persists the resulting token so future launches skip pairing
 * entirely — that's device-auth.client.ts's job on the way back in. In an
 * ordinary browser, reachable only by hand-navigating to /pair, there's
 * nowhere to persist a token, so this just opens a session for that one tab.
 */
export async function claimPairingCode(code: string): Promise<void> {
  const { token } = await $fetch<{ token: string; device_id: number }>('/api/devices/claim', {
    method: 'POST',
    body: { code },
  })

  if (Capacitor.isNativePlatform()) {
    await DeviceToken.setToken({ token })
  }

  await $fetch('/auth/device', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

  await useUserSession().fetch()
}

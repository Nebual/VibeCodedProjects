import { todayIn } from '~/utils/dates'

const TZ_COOKIE = 'fittown_tz'

/**
 * The browser's IANA timezone, persisted in a cookie so the server can compute
 * the same "today" the user sees.
 *
 * Without this, SSR renders whichever day it is *on the host* — which is a
 * different day from the user's for several hours every evening whenever the
 * host runs in UTC and the user doesn't.
 */
export function useClientTimezone() {
  // Read-only here. The value is written once per session by
  // plugins/timezone.client.ts, which waits until hydration is finished.
  return useCookie<string | null>(TZ_COOKIE, {
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    path: '/',
  })
}

/**
 * Today's date in the user's timezone, or `null` on the very first server
 * render before the browser has ever reported its zone.
 *
 * Callers treat `null` as "not known yet" and hold off fetching, which keeps
 * the server and client markup identical on that first request instead of
 * producing a hydration mismatch.
 */
export function useToday(): ComputedRef<string | null> {
  const tz = useClientTimezone()
  return computed(() => (tz.value ? todayIn(tz.value) : null))
}

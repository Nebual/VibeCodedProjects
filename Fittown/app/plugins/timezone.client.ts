/**
 * Record the browser's timezone so the server can compute the same "today".
 *
 * Deliberately runs on `onNuxtReady` — after hydration has fully finished —
 * rather than in a component's `onMounted`. Writing the cookie any earlier
 * flips `useToday()` from null to a real date while Vue is still walking the
 * server-rendered tree, which shows up as hydration mismatches in whichever
 * component happens to be mid-hydration.
 *
 * The cost is that the very first page view of a session renders without a
 * date and fills in a moment later; every subsequent request is server-
 * rendered with the correct day.
 */
export default defineNuxtPlugin(() => {
  onNuxtReady(() => {
    const cookie = useCookie<string | null>('fittown_tz', {
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      path: '/',
    })

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    // Also refreshes the value if the user travels across timezones.
    if (tz && cookie.value !== tz) cookie.value = tz
  })
})

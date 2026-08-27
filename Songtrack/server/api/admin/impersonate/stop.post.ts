export default defineEventHandler(async (event) => {
  // Checks the REAL signed-in user, unaffected by any active impersonation.
  await requireAdmin(event)

  // An empty string, deliberately. There is no way to *remove* a session key here, and both
  // obvious alternatives silently do nothing:
  //
  //  - `replaceUserSession({ user })` dropped the key under h3 v1, but this project pins h3
  //    2.0.1-rc, where it does not. `clearSession` deletes the session from the event context, and
  //    the `updateSession` that follows falls back to `getSession`, which re-unseals the *incoming
  //    request cookie* and restores everything it held. `impersonatingUserId` came straight back
  //    with the merged `{ user }` on top, so Exit returned 200, issued a fresh cookie, and changed
  //    nothing at all.
  //  - `setUserSession({ impersonatingUserId: null })` is a no-op too: nuxt-auth-utils merges with
  //    defu, which skips null *and* undefined values rather than writing them.
  //
  // An empty string survives defu and is falsy, which is exactly what `requireActor` tests for.
  await setUserSession(event, { impersonatingUserId: '' })
  return { ok: true }
})

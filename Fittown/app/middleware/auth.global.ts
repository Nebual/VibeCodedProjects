/**
 * Gate every page behind a session, except the login screen and the two link
 * targets that have to work before you have an account.
 *
 * Global rather than per-page so a new page is private by default — the safer
 * direction to fail in for a personal health diary.
 *
 * The public prefixes are both token-addressed: `/r/<token>` is a recipe its
 * owner deliberately published, and `/invite/<token>` has to be readable by
 * somebody who has never signed in, or an invitation is just a login wall. Both
 * are safe to open because the *page* shows nothing a token doesn't already
 * entitle its holder to, and every mutation behind them still requires a user.
 */
const PUBLIC_ROUTES = new Set(['/login'])
const PUBLIC_PREFIXES = ['/r/', '/invite/']

export default defineNuxtRouteMiddleware((to) => {
  if (PUBLIC_ROUTES.has(to.path)) return
  if (PUBLIC_PREFIXES.some((prefix) => to.path.startsWith(prefix))) return

  const { loggedIn } = useUserSession()
  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})

/**
 * Gate every page behind a session, except the login screen.
 *
 * Global rather than per-page so a new page is private by default — the safer
 * direction to fail in for a personal health diary.
 */
const PUBLIC_ROUTES = new Set(['/login'])

export default defineNuxtRouteMiddleware((to) => {
  if (PUBLIC_ROUTES.has(to.path)) return

  const { loggedIn } = useUserSession()
  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})

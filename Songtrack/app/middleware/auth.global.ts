const PUBLIC_PREFIXES = ['/s/', '/a/']
const PUBLIC_PATHS = new Set(['/login', '/access-denied', '/signups-closed'])

export default defineNuxtRouteMiddleware((to) => {
  if (PUBLIC_PATHS.has(to.path) || PUBLIC_PREFIXES.some(p => to.path.startsWith(p))) {
    return
  }

  const { loggedIn } = useUserSession()
  if (!loggedIn.value) {
    return navigateTo('/login')
  }
})

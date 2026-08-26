import { computed } from 'vue'

export type Identity = { playerId: string; playerName: string; leagueId: string }

const STORAGE_KEY = 'bloodtrack.identity'

export function useIdentity() {
  const identity = useState<Identity | null>('bloodtrack-identity', () => {
    if (import.meta.client) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        return raw ? (JSON.parse(raw) as Identity) : null
      } catch {
        return null
      }
    }
    return null
  })

  // re-read on client hydration in case useState default ran on server
  if (import.meta.client && !identity.value) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) identity.value = JSON.parse(raw) as Identity
    } catch {
      /* ignore */
    }
  }

  function login(id: Identity) {
    identity.value = id
    localStorage.setItem(STORAGE_KEY, JSON.stringify(id))
  }

  function logout() {
    identity.value = null
    localStorage.removeItem(STORAGE_KEY)
    navigateTo('/')
  }

  const isLoggedIn = computed(() => !!identity.value)

  return { identity, isLoggedIn, login, logout }
}

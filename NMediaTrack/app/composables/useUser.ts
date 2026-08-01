// Tracks the current user's chosen name, persisted in localStorage. There is no
// auth — the name is simply an identity used to scope which lists you see/edit.
const STORAGE_KEY = 'nmediatrack.user'

export const useUser = () => {
  const name = useState<string>('user-name', () => '')
  const ready = useState<boolean>('user-ready', () => false)

  const load = () => {
    if (import.meta.client && !ready.value) {
      name.value = localStorage.getItem(STORAGE_KEY) || ''
      ready.value = true
    }
  }

  const setName = (value: string) => {
    const trimmed = value.trim()
    name.value = trimmed
    if (import.meta.client) {
      if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed)
      else localStorage.removeItem(STORAGE_KEY)
    }
  }

  const clear = () => setName('')

  return { name, ready, load, setName, clear }
}

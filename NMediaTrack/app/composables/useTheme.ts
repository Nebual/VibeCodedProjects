// Light/dark theme, persisted in localStorage and applied as `data-theme` on
// <html>. The initial value is also set by an inline script in nuxt.config so
// the correct theme paints before hydration (no flash of the wrong theme).
export const THEME_STORAGE_KEY = 'nmediatrack.theme'

export const THEMES = { light: 'nord', dark: 'night' } as const
export type ThemeMode = keyof typeof THEMES

export const useTheme = () => {
  const mode = useState<ThemeMode>('theme-mode', () => 'dark')

  function apply(m: ThemeMode) {
    if (import.meta.client) {
      document.documentElement.setAttribute('data-theme', THEMES[m])
    }
  }

  /** Sync state with whatever the inline script already decided. */
  function load() {
    if (!import.meta.client) return
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') {
      mode.value = stored
    } else {
      mode.value = window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
    }
    apply(mode.value)
  }

  function setMode(m: ThemeMode) {
    mode.value = m
    if (import.meta.client) localStorage.setItem(THEME_STORAGE_KEY, m)
    apply(m)
  }

  const toggle = () => setMode(mode.value === 'dark' ? 'light' : 'dark')

  const isDark = computed(() => mode.value === 'dark')

  return { mode, isDark, load, setMode, toggle }
}

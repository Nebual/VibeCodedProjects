export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'nshoppinglist:theme'

/** The DaisyUI themes behind each explicit choice. `system` sets no attribute at all. */
const DAISY_THEME: Record<Exclude<ThemePreference, 'system'>, string> = {
  light: 'emerald',
  dark: 'dim',
}

export const THEME_OPTIONS: { value: ThemePreference, label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function useTheme() {
  // Shared across every component that asks for it.
  const preference = useState<ThemePreference>('theme-preference', () => 'system')

  function apply(value: ThemePreference) {
    const root = document.documentElement
    // Removing the attribute hands control back to DaisyUI's prefers-color-scheme rule.
    if (value === 'system') delete root.dataset.theme
    else root.dataset.theme = DAISY_THEME[value]
  }

  function setTheme(value: ThemePreference) {
    preference.value = value
    apply(value)
    try {
      if (value === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
      else localStorage.setItem(THEME_STORAGE_KEY, value)
    }
    catch {
      // Private mode with storage disabled: the choice just won't outlive the tab.
    }
  }

  onMounted(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY)
      if (isPreference(stored)) preference.value = stored
    }
    catch {
      // Ignore — stay on system.
    }
    // The inline head script has already painted the right theme; this keeps Vue in step.
    apply(preference.value)
  })

  return { preference, setTheme }
}

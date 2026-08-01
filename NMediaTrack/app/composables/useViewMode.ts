// Cards vs. list layout, remembered per device. Read on mount rather than
// during setup so SSR and the first client render agree.
const STORAGE_KEY = 'nmediatrack.view'

export type ViewMode = 'cards' | 'list'

export const useViewMode = () => {
  const mode = useState<ViewMode>('view-mode', () => 'cards')

  function load() {
    if (!import.meta.client) return
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'cards' || stored === 'list') mode.value = stored
  }

  function setMode(m: ViewMode) {
    mode.value = m
    if (import.meta.client) localStorage.setItem(STORAGE_KEY, m)
  }

  return { mode, load, setMode }
}

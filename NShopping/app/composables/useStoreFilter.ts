export const STORE_FILTER_STORAGE_KEY = 'nshoppinglist:hide-other-store'

/**
 * Whether to hide the items marked for another shop, so a trip to the main one shows only
 * what can actually be picked up there.
 *
 * Persisted, like the theme, because it is a mode you are in for a whole trip and a phone
 * in a pocket reloads the page more often than you'd think. That makes it a filter you can
 * come home to still switched on, which is why the list keeps a count of what it is holding
 * back rather than quietly showing you a shorter list.
 */
export function useStoreFilter() {
  // Shared across every component that asks for it.
  const hideOtherStore = useState<boolean>('hide-other-store', () => false)

  function setHideOtherStore(value: boolean) {
    hideOtherStore.value = value
    try {
      if (value) localStorage.setItem(STORE_FILTER_STORAGE_KEY, '1')
      else localStorage.removeItem(STORE_FILTER_STORAGE_KEY)
    }
    catch {
      // Private mode with storage disabled: the choice just won't outlive the tab.
    }
  }

  onMounted(() => {
    try {
      if (localStorage.getItem(STORE_FILTER_STORAGE_KEY) === '1') hideOtherStore.value = true
    }
    catch {
      // Ignore — show everything.
    }
  })

  return { hideOtherStore, setHideOtherStore }
}

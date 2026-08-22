import type { EssentiaSnapshot, TargetKind } from '~~/server/utils/essentiaStore'

const EMPTY: EssentiaSnapshot = {
  essentia: [],
  items: {},
  minimums: {},
  maximums: {},
  updatedAt: null,
  maxEssentiaTypes: 0,
  maxEssentiaAmount: 0,
  acceptingTargets: false,
}

/**
 * Current essentia stock: server-rendered from the last known snapshot, then
 * kept live over SSE so a POST to /api/essentia refreshes the page by itself.
 */
export function useEssentiaStock() {
  const { data, refresh } = useAsyncData<EssentiaSnapshot>(
    'essentia',
    () => $fetch('/api/essentia'),
    { default: () => EMPTY },
  )

  const connected = ref(false)
  let source: EventSource | null = null

  onMounted(() => {
    source = new EventSource('/api/essentia/stream')
    source.onopen = () => (connected.value = true)
    source.onerror = () => (connected.value = false)
    source.onmessage = (message) => {
      if (!message.data) return
      try {
        data.value = JSON.parse(message.data) as EssentiaSnapshot
        connected.value = true
      } catch {
        // Ignore malformed frames; the next push will resync us.
      }
    }
  })

  onBeforeUnmount(() => {
    source?.close()
    source = null
    connected.value = false
  })

  /** Persist one aspect's min/max target. Applies the response immediately so the
   *  tile settles without waiting for the SSE echo. */
  async function saveTarget(name: string, kind: TargetKind, value: number | null) {
    data.value = await $fetch<EssentiaSnapshot>('/api/essentia/target', {
      method: 'PATCH',
      body: { name, kind, value },
    })
  }

  /** Let the next external report re-seed the min/max targets. */
  async function resetTargets() {
    data.value = await $fetch<EssentiaSnapshot>('/api/essentia/reset-targets', { method: 'POST' })
  }

  return { snapshot: data, connected, refresh, saveTarget, resetTargets }
}

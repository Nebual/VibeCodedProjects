import type { Ref } from 'vue'

/**
 * Remembered voice and model choice.
 *
 * Two layers: a global default used by any book you have not chosen for, and a
 * per-book override once you have. Picking a narrator for one book should not
 * silently change every other book, but it should become the default for the
 * next one you open.
 */

const GLOBAL_KEY = 'nab.voice.default'
const BOOK_KEY = (bookId: string) => `nab.voice.book.${bookId}`

export interface VoiceChoice {
  model: string
  voice: string
  speed: number
}

const FALLBACK: VoiceChoice = { model: 'kokoro', voice: 'af_heart', speed: 1.0 }

function read(key: string): Partial<VoiceChoice> | null {
  if (import.meta.server) return null
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }
  catch {
    // Corrupt or unavailable storage must never break the page; a forgotten
    // preference is a far smaller problem than a blank screen.
    return null
  }
}

function write(key: string, value: VoiceChoice): void {
  if (import.meta.server) return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  }
  catch {
    // Private browsing, or a full quota. Not worth surfacing.
  }
}

export function useVoicePreference(bookId?: string) {
  const choice = ref<VoiceChoice>({ ...FALLBACK })
  const loaded = ref(false)

  onMounted(() => {
    // Read on mount rather than at setup: localStorage does not exist during
    // server rendering, and reading it during hydration causes a mismatch.
    const stored = { ...FALLBACK, ...read(GLOBAL_KEY), ...(bookId ? read(BOOK_KEY(bookId)) : {}) }
    choice.value = stored as VoiceChoice
    loaded.value = true
  })

  watch(
    choice,
    (value) => {
      if (!loaded.value) return
      // The latest choice becomes the default for books not yet chosen for,
      // and is pinned to this book so it survives being changed elsewhere.
      write(GLOBAL_KEY, value)
      if (bookId) write(BOOK_KEY(bookId), value)
    },
    { deep: true },
  )

  return {
    choice,
    loaded,
    model: computed({
      get: () => choice.value.model,
      set: (v: string) => { choice.value = { ...choice.value, model: v } },
    }) as Ref<string>,
    voice: computed({
      get: () => choice.value.voice,
      set: (v: string) => { choice.value = { ...choice.value, voice: v } },
    }) as Ref<string>,
    speed: computed({
      get: () => choice.value.speed,
      set: (v: number) => { choice.value = { ...choice.value, speed: v } },
    }) as Ref<number>,
  }
}

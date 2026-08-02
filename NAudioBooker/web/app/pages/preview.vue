<script setup lang="ts">
/**
 * Speak arbitrary text, outside any book.
 *
 * The same controls the narration panel uses, minus the book: handy for
 * comparing voices, hearing how a model reads an awkward name, or just using
 * the thing as a text-to-speech box.
 *
 * A page rather than a fancier /api/preview response because a browser will
 * not reliably play raw audio at a URL -- Firefox downloads audio/wav rather
 * than showing a player, whatever headers it is sent. An <audio> element on a
 * page works everywhere.
 */

/**
 * Metadata for link unfurls, computed during setup rather than on mount:
 * a crawler does not run JavaScript, so anything applied later is invisible
 * to it. Reading route.query directly here is safe -- it is available on the
 * server, unlike the localStorage preference.
 *
 * og:video rather than og:audio because Discord has no audio embed. og:audio
 * is unimplemented there, and a direct link to an audio file gets no player;
 * a plain MP4 pointed at by og:video does embed.
 */
const route = useRoute()

const shared = computed(() => {
  const q = route.query
  const pick = (v: unknown) => (Array.isArray(v) ? v.at(-1) : v) as string | undefined
  const params = new URLSearchParams()
  for (const key of ['text', 'voice', 'model', 'speed', 'exaggeration', 'cfg_weight']) {
    const value = pick(q[key])
    if (value) params.set(key, value)
  }
  return { text: pick(q.text), params: params.toString() }
})

const origin = useRequestURL().origin

useHead({ title: 'Preview — NAudioBooker' })
useSeoMeta({
  ogTitle: 'NAudioBooker preview',
  // The spoken words are the useful part of the unfurl.
  ogDescription: () => shared.value.text ?? 'Speak any text in any voice.',
  ogType: 'video.other',
  // Absolute: a crawler has no page to resolve a relative URL against.
  ogVideo: () => (shared.value.text ? `${origin}/api/preview.mp4?${shared.value.params}` : undefined),
  ogVideoType: () => (shared.value.text ? 'video/mp4' : undefined),
  ogVideoWidth: () => (shared.value.text ? 640 : undefined),
  ogVideoHeight: () => (shared.value.text ? 360 : undefined),
  twitterCard: 'player',
})

// No book id, so the sample phrases are the stock ones and the preference is
// the global default rather than a per-book override.
const { model, voice, speed, tuning } = useVoicePreference()

const text = ref('')
const picker = ref<{ activeTuning: Record<string, number>, play: () => void } | null>(null)

const TUNING_KNOBS = ['exaggeration', 'cfg_weight'] as const

function one(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value.at(-1) : value
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function num(value: unknown): number | undefined {
  const raw = one(value)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Adopt whatever the URL specifies, using the same parameter names as
 * /api/preview, so a link works against either.
 *
 * Applied on mount rather than during setup because useVoicePreference reads
 * localStorage on mount too, and the URL has to win over the stored default.
 * The composable registers its hook first, during setup, so it has already
 * run by the time this does.
 */
onMounted(async () => {
  const query = route.query

  const wantedModel = one(query.model)
  const wantedVoice = one(query.voice)
  const wantedSpeed = num(query.speed)
  const wantedText = one(query.text)

  if (wantedModel) model.value = wantedModel
  if (wantedSpeed !== undefined) speed.value = wantedSpeed
  if (wantedText) text.value = wantedText

  const knobs: Record<string, number> = {}
  for (const knob of TUNING_KNOBS) {
    const value = num(query[knob])
    if (value !== undefined) knobs[knob] = value
  }
  if (Object.keys(knobs).length) {
    tuning.value = {
      ...tuning.value,
      [model.value]: { ...tuning.value[model.value], ...knobs },
    }
  }

  // Voice last. The picker clears the voice whenever the model changes --
  // a clip id means nothing to Kokoro and vice versa -- so setting it before
  // that watcher has run would simply be undone.
  await nextTick()
  if (wantedVoice) voice.value = wantedVoice

  if (wantedText) {
    await nextTick()
    picker.value?.play()
  }
})

/** The GET form of whatever is currently selected, for scripts and bookmarks. */
const directUrl = computed(() => {
  const params = new URLSearchParams({
    text: text.value.trim() || '<your text>',
    model: model.value,
  })
  if (voice.value) params.set('voice', voice.value)
  if (speed.value !== 1) params.set('speed', String(speed.value))
  for (const [knob, value] of Object.entries(picker.value?.activeTuning ?? {})) {
    params.set(knob, String(value))
  }
  return `/api/preview?${params}`
})

/** The same settings as a link to this page -- what you paste into Discord. */
const pageUrl = computed(() => directUrl.value.replace('/api/preview?', '/preview?'))

const copied = ref<string | null>(null)
async function copy(which: 'api' | 'page') {
  const url = which === 'api' ? directUrl.value : pageUrl.value
  await navigator.clipboard.writeText(new URL(url, location.origin).toString())
  copied.value = which
  setTimeout(() => (copied.value = null), 1500)
}
</script>

<template>
  <div class="space-y-6">
    <section>
      <NuxtLink to="/" class="link link-hover text-base-content/60 text-sm">
        ← Library
      </NuxtLink>
      <h1 class="mt-2 text-2xl font-semibold">
        Preview
      </h1>
      <p class="text-base-content/60 mt-1 text-sm">
        Speak any text in any voice. Nothing here is saved to a book.
      </p>
    </section>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body gap-3">
        <VoicePicker
          ref="picker"
          v-model:model="model"
          v-model:voice="voice"
          v-model:speed="speed"
          v-model:tuning="tuning"
          v-model:text="text"
        />
      </div>
    </section>

    <!-- The same thing without the UI, for scripting. -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body gap-2">
        <h2 class="card-title text-sm">
          As a URL
        </h2>
        <p class="text-base-content/60 text-xs">
          These settings as a plain GET request — usable from curl, a script, or an
          <code>&lt;audio src&gt;</code>. Chrome plays it in a tab; Firefox downloads it,
          because it will not display a WAV inline. This page takes the same
          parameters, so swapping <code>/api/preview</code> for <code>/preview</code>
          gives a link that opens here and plays on arrival.
        </p>
        <div class="space-y-2">
          <div v-for="row in [
                 { key: 'api' as const, label: 'Audio', url: directUrl },
                 { key: 'page' as const, label: 'Page', url: pageUrl },
               ]"
               :key="row.key"
               class="flex flex-wrap items-center gap-2"
          >
            <span class="text-base-content/50 w-12 shrink-0 text-xs">{{ row.label }}</span>
            <code class="bg-base-200 rounded-box min-w-0 flex-1 overflow-x-auto p-2 text-xs">
              {{ row.url }}
            </code>
            <button class="btn btn-ghost btn-sm" @click="copy(row.key)">
              {{ copied === row.key ? 'Copied' : 'Copy' }}
            </button>
          </div>
        </div>
        <p class="text-base-content/40 text-xs">
          Paste the page link into Discord and it unfurls with a player, via an
          MP4 rendition at <code>/api/preview.mp4</code> — Discord embeds video
          but has no audio embed at all.
        </p>
      </div>
    </section>
  </div>
</template>

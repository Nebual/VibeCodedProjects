<script setup lang="ts">
import type { ModelInfo, VoiceClipInfo, VoiceInfo } from '~/types/api'

const props = defineProps<{
  bookId?: string
  /** Audio length of the selected chapters, for the render-time estimate. */
  estSeconds?: number
}>()

const model = defineModel<string>('model', { required: true })
const voice = defineModel<string>('voice', { required: true })
const speed = defineModel<number>('speed', { default: 1.0 })
/** Tuning per model id, so switching away and back keeps your settings. */
const tuning = defineModel<Record<string, Record<string, number>>>('tuning', {
  default: () => ({}),
})

const { data: models } = await useFetch<ModelInfo[]>('/api/models', { default: () => [] })
const { data: voices } = await useFetch<VoiceInfo[]>('/api/voices', { default: () => [] })
const { data: clips, refresh: refreshClips } = await useFetch<VoiceClipInfo[]>(
  '/api/voice-clips',
  { default: () => [] },
)

const current = computed(() => models.value.find(m => m.id === model.value))

// -- per-model tuning ---------------------------------------------------------

/** Knobs the current model declares. Empty for models without any. */
const knobs = computed(() => current.value?.tuning ?? [])

function knobValue(id: string): number {
  const stored = tuning.value[model.value]?.[id]
  if (stored !== undefined) return stored
  return knobs.value.find(k => k.id === id)?.default ?? 0
}

function setKnob(id: string, value: number) {
  tuning.value = {
    ...tuning.value,
    [model.value]: { ...tuning.value[model.value], [id]: value },
  }
}

function resetKnobs() {
  const { [model.value]: _dropped, ...rest } = tuning.value
  tuning.value = rest
}

/**
 * Only the knobs actually moved away from their default.
 *
 * Sending defaults explicitly would work, but it would also put a tuning
 * token in the cache key for every render -- so an untuned book would miss
 * every chunk already cached from before this feature existed.
 */
const activeTuning = computed(() => {
  const out: Record<string, number> = {}
  for (const knob of knobs.value) {
    const value = knobValue(knob.id)
    if (Math.abs(value - knob.default) > 1e-9) out[knob.id] = value
  }
  return out
})

const isTuned = computed(() => Object.keys(activeTuning.value).length > 0)

// Exposed for /preview, which prefills from the query string and then asks
// for the preview itself.
defineExpose({ activeTuning, play: () => play() })

/**
 * How long this model would take on the selected chapters.
 *
 * Shown next to every model because the spread is enormous -- measured on one
 * GPU, the same book is 24 minutes on Kokoro and over eight hours on
 * Chatterbox. That is the single most decision-relevant fact here, and it
 * should not require reading documentation to discover.
 */
function estimateFor(m: ModelInfo): string | null {
  if (!props.estSeconds || !m.gpu_rtf_hint) return null
  return duration(props.estSeconds / m.gpu_rtf_hint)
}

/** Warn only when the wait is genuinely long, in wall-clock terms. */
const LONG_RENDER_SECONDS = 30 * 60

const longRender = computed(() => {
  const spec = current.value
  if (!spec?.gpu_rtf_hint || !props.estSeconds) return null
  const seconds = props.estSeconds / spec.gpu_rtf_hint
  return seconds >= LONG_RENDER_SECONDS ? duration(seconds) : null
})

const LANGUAGE_NAMES: Record<string, string> = {
  'en-us': 'American English',
  'en-gb': 'British English',
}

const grouped = computed(() => {
  const groups = new Map<string, VoiceInfo[]>()
  for (const v of voices.value) {
    if (!groups.has(v.language)) groups.set(v.language, [])
    groups.get(v.language)!.push(v)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
})

// -- uploading a reference clip ---------------------------------------------

const uploading = ref(false)
const uploadError = ref<string | null>(null)
const clipName = ref('')
const clipInput = ref<HTMLInputElement | null>(null)

async function uploadClip(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return

  uploading.value = true
  uploadError.value = null
  try {
    const form = new FormData()
    form.append('name', clipName.value.trim() || file.name.replace(/\.[^.]+$/, ''))
    form.append('file', file)
    const clip = await $fetch<VoiceClipInfo>('/api/voice-clips', { method: 'POST', body: form })
    await refreshClips()
    voice.value = clip.id
    clipName.value = ''
  }
  catch (e: unknown) {
    const err = e as { data?: { detail?: string } }
    uploadError.value = err.data?.detail ?? 'Could not upload that clip.'
  }
  finally {
    uploading.value = false
    if (clipInput.value) clipInput.value.value = ''
  }
}

async function deleteClip(clip: VoiceClipInfo) {
  if (!confirm(`Delete the voice "${clip.name}"?`)) return
  await $fetch(`/api/voice-clips/${clip.id}`, { method: 'DELETE' })
  await refreshClips()
}

// Keep the voice valid when the model changes: a cloned clip is meaningless to
// Kokoro, and a Kokoro voice id is meaningless to a cloning model.
watch(current, (spec) => {
  if (!spec) return
  const isClip = voice.value.startsWith('clip-')
  if (spec.supports_cloning && !isClip) {
    voice.value = clips.value[0]?.id ?? ''
  }
  else if (!spec.supports_cloning && isClip) {
    voice.value = voices.value[0]?.id ?? 'af_heart'
  }
})

// -- preview ----------------------------------------------------------------

/** The words to speak. A model so a parent can prefill it -- /preview takes
 *  it from the query string so a link can carry the text. */
const sampleText = defineModel<string>('text', { default: '' })
const previewing = ref(false)
const previewError = ref<string | null>(null)
const audioUrl = ref<string | null>(null)
/** Filename the server suggests, so downloads say which combination they are. */
const downloadName = ref('preview.wav')
/** Whether the last preview came back from the cache rather than the model. */
const fromCache = ref(false)
/**
 * Set when the browser refused to start playback on its own.
 *
 * Every browser blocks a programmatic play() that no click led to, which is
 * exactly the case when /preview is opened from a link carrying ?text. The
 * audio is loaded and one press away, so this only exists to say so -- a
 * silent player looks like a failure.
 */
const autoplayBlocked = ref(false)

async function play() {
  previewing.value = true
  previewError.value = null
  try {
    // Raw response rather than the parsed body: the filename and the
    // cache-hit flag both arrive as headers.
    const response = await $fetch.raw<Blob>('/api/preview', {
      method: 'POST',
      responseType: 'blob',
      body: {
        voice: voice.value,
        speed: speed.value,
        model: model.value,
        text: sampleText.value.trim() || null,
        options: activeTuning.value,
      },
    })
    if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
    audioUrl.value = URL.createObjectURL(response._data as Blob)
    downloadName.value = filenameFrom(response.headers) ?? 'preview.wav'
    fromCache.value = response.headers.get('x-cache') === 'hit'
    await nextTick()
    autoplayBlocked.value = false
    try {
      await document.querySelector<HTMLAudioElement>('#voice-preview')?.play()
    }
    catch {
      // No user gesture led here, so the browser declined. Not an error.
      autoplayBlocked.value = true
    }
  }
  catch (e: unknown) {
    previewError.value = await detailFrom(e)
  }
  finally {
    previewing.value = false
  }
}

function filenameFrom(headers: Headers): string | null {
  const match = /filename="([^"]+)"/.exec(headers.get('content-disposition') ?? '')
  return match?.[1] ?? null
}

/**
 * The server's explanation, dug out from behind responseType: 'blob'.
 *
 * A successful preview is audio, so the response is read as a blob -- and an
 * error response is read the same way, leaving err.data a Blob rather than the
 * parsed body. Every failure therefore showed the same "Preview failed.",
 * hiding messages that name the exact problem and its fix.
 *
 * Only the decoding is done here; readApiDetail knows the shapes, and the
 * Nitro route needs exactly the same knowledge.
 */
async function detailFrom(e: unknown): Promise<string> {
  const data = (e as { data?: unknown }).data

  if (data instanceof Blob) {
    const detail = readApiDetailFromText(await data.text())
    if (detail) return detail
  }
  else if (data && typeof data === 'object') {
    const detail = readApiDetail(data)
    if (detail) return detail
  }

  return 'Preview failed.'
}

const needsClip = computed(() => current.value?.supports_cloning && !clips.value.length)
</script>

<template>
  <div class="space-y-4">
    <!-- Model -->
    <div class="space-y-2">
      <label class="form-control">
        <div class="label py-1">
          <span class="label-text text-xs mr-1">Model</span>
        </div>
        <select v-model="model" class="select select-bordered select-sm w-full max-w-md">
          <option v-for="m in models" :key="m.id" :value="m.id">
            {{ m.label }}<template v-if="estimateFor(m)"> — about {{ estimateFor(m) }}</template>
          </option>
        </select>
      </label>

      <p v-if="current" class="text-base-content/60 text-xs">
        {{ current.notes }}
      </p>

      <!-- The two facts worth interrupting for: it will be slow, and it may
           not run here at all. -->
      <div v-if="current && !current.cpu_viable" class="alert alert-soft alert-info py-2 text-xs">
        <span>
          Needs the GPU node.
          <template v-if="current.node_url">Configured at <code>{{ current.node_url }}</code>.</template>
          <template v-else>No node is configured, so this will not run.</template>
        </span>
      </div>
      <!-- Keyed on the estimate, not on the model being slow: a slow model on
           two short chapters is still a few minutes, and calling that an
           overnight job would be plainly wrong. -->
      <div v-if="longRender" class="alert alert-soft alert-warning py-2 text-xs">
        <span>
          Roughly <strong>{{ longRender }}</strong> to render this selection.
        </span>
      </div>
    </div>

    <!-- Voice -->
    <div v-if="current?.has_builtin_voices" class="flex flex-wrap items-end gap-3">
      <label class="form-control">
        <div class="label py-1">
          <span class="label-text text-xs">Voice</span>
        </div>
        <select v-model="voice" class="select select-bordered select-sm w-64">
          <optgroup
            v-for="[language, items] in grouped"
            :key="language"
            :label="LANGUAGE_NAMES[language] ?? language"
          >
            <option v-for="v in items" :key="v.id" :value="v.id">
              {{ v.label }}
            </option>
          </optgroup>
        </select>
      </label>
    </div>

    <!-- Cloned voices -->
    <div v-else-if="current?.supports_cloning" class="space-y-2">
      <div class="label py-1">
        <span class="label-text text-xs">Cloned voice</span>
      </div>

      <p v-if="needsClip" class="text-base-content/60 text-xs">
        This model has no built-in voices. Upload a clear recording of 3–30
        seconds to clone from — WAV, FLAC, OGG, MP3 or M4A, including straight
        off a phone.
      </p>

      <ul v-else class="divide-base-200 divide-y">
        <li v-for="clip in clips" :key="clip.id" class="flex items-center gap-3 py-1.5">
          <input
            v-model="voice"
            type="radio"
            class="radio radio-sm"
            :value="clip.id"
            :aria-label="clip.name"
          >
          <span class="min-w-32 lg:min-w-64 truncate text-sm">{{ clip.name }}</span>
          <span class="text-base-content/40 text-xs">{{ clip.duration_s.toFixed(1) }}s</span>
          <audio
            controls
            preload="none"
            class="h-8 w-40"
            :src="`/api/voice-clips/${clip.id}/audio`"
          />
          <button class="btn btn-ghost btn-xs text-error" @click="deleteClip(clip)">
            Delete
          </button>
        </li>
      </ul>

      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="clipName"
          class="input input-bordered input-sm w-48"
          placeholder="Name this voice"
        >
        <input
          ref="clipInput"
          type="file"
          accept="audio/*,.wav,.flac,.ogg,.mp3,.m4a,.aac,.opus"
          class="file-input file-input-bordered file-input-sm w-64"
          :disabled="uploading"
          @change="uploadClip"
        >
        <span v-if="uploading" class="loading loading-spinner loading-sm" />
      </div>
      <p v-if="uploadError" class="text-error text-xs">
        {{ uploadError }}
      </p>
    </div>

    <!-- Per-model tuning. Rendered from what the model declares, so adding a
         knob to a model needs no change here. -->
    <div v-if="knobs.length" class="space-y-3">
      <div class="flex items-center gap-2">
        <span class="label-text text-xs font-medium">Delivery</span>
        <button
          v-if="isTuned"
          class="btn btn-ghost btn-xs"
          @click="resetKnobs"
        >
          Reset
        </button>
        <span v-else class="text-base-content/40 text-xs">defaults</span>
      </div>

      <div class="flex flex-wrap gap-x-10 gap-y-4">
        <div v-for="knob in knobs" :key="knob.id" class="w-56 space-y-1.5">
          <div class="text-xs">
            {{ knob.label }}
            <span class="text-base-content/50 font-mono">{{ knobValue(knob.id).toFixed(2) }}</span>
          </div>
          <input
            type="range"
            class="range range-xs w-full"
            :min="knob.minimum"
            :max="knob.maximum"
            :step="knob.step"
            :value="knobValue(knob.id)"
            :aria-label="knob.label"
            @input="setKnob(knob.id, Number(($event.target as HTMLInputElement).value))"
          >
          <p class="text-base-content/40 text-xs leading-snug">
            {{ knob.hint }}
          </p>
        </div>
      </div>
    </div>

    <!-- Speed. Same column width as a tuning knob so the controls line up. -->
    <div class="w-56 space-y-1.5">
      <div class="text-xs">
        Speed
        <span class="text-base-content/50 font-mono">{{ speed.toFixed(2) }}×</span>
      </div>
      <input
        v-model.number="speed"
        type="range"
        min="0.7"
        max="1.4"
        step="0.05"
        class="range range-xs w-full"
        aria-label="Speed"
      >
    </div>

    <SamplePhrase v-model="sampleText" :book-id="bookId">
      <template #actions>
        <button class="btn btn-sm btn-primary" :disabled="previewing || !voice" @click="play">
          <span v-if="previewing" class="loading loading-spinner loading-xs" />
          {{ previewing ? 'Rendering…' : 'Preview' }}
        </button>
      </template>
    </SamplePhrase>

    <div v-if="audioUrl" class="flex flex-wrap items-center gap-2">
      <audio
        id="voice-preview"
        :src="audioUrl"
        controls
        class="h-9 w-full max-w-md"
      />
      <!-- The blob is already here, so this costs no second synthesis and no
           second request -- which is the point when comparing a dozen takes. -->
      <a
        class="btn btn-ghost btn-sm"
        :href="audioUrl"
        :download="downloadName"
      >
        Download
      </a>
      <span v-if="autoplayBlocked" class="text-base-content/60 text-xs">
        Ready — press play.
      </span>
      <span v-if="fromCache" class="text-base-content/40 text-xs">
        from cache
      </span>
    </div>
    <p v-if="previewError" class="text-error text-xs">
      {{ previewError }}
    </p>
  </div>
</template>

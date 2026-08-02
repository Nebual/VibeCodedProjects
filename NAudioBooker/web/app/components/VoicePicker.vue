<script setup lang="ts">
import type { VoiceInfo } from '~/types/api'

const voice = defineModel<string>('voice', { required: true })
const speed = defineModel<number>('speed', { default: 1.0 })

const props = defineProps<{
  /** Optional text to speak instead of the built-in sample sentence. */
  sampleText?: string
}>()

const { data: voices, error } = await useFetch<VoiceInfo[]>('/api/voices', {
  default: () => [],
})

/** Grouped so the English voices are not lost among the other nine languages. */
const grouped = computed(() => {
  const groups = new Map<string, VoiceInfo[]>()
  for (const v of voices.value) {
    const key = v.language
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(v)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
})

const previewing = ref(false)
const previewError = ref<string | null>(null)
const audioUrl = ref<string | null>(null)

async function play() {
  previewing.value = true
  previewError.value = null
  try {
    const blob = await $fetch<Blob>('/api/preview', {
      method: 'POST',
      body: { voice: voice.value, speed: speed.value, text: props.sampleText ?? null },
      responseType: 'blob',
    })
    // Release the previous clip; these are a few hundred KB each and the
    // browser will not reclaim them on its own.
    if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
    audioUrl.value = URL.createObjectURL(blob)
    await nextTick()
    document.querySelector<HTMLAudioElement>('#voice-preview')?.play()
  }
  catch (e: unknown) {
    const err = e as { data?: { detail?: string } }
    previewError.value = err.data?.detail ?? 'Preview failed.'
  }
  finally {
    previewing.value = false
  }
}

onBeforeUnmount(() => {
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
})

const LANGUAGE_NAMES: Record<string, string> = {
  'en-us': 'American English',
  'en-gb': 'British English',
  'es': 'Spanish',
  'fr-fr': 'French',
  'hi': 'Hindi',
  'it': 'Italian',
  'ja': 'Japanese',
  'pt-br': 'Brazilian Portuguese',
  'cmn': 'Mandarin',
}
</script>

<template>
  <div class="space-y-3">
    <!-- Show what the server actually said. A hardcoded guess here ("check the
         model files") sends people to verify things that were never wrong. -->
    <div v-if="error" class="alert alert-warning text-sm">
      <div>
        <div class="font-medium">
          No voices available
        </div>
        <div class="mt-1 font-mono text-xs opacity-80">
          {{ error.data?.detail ?? error.data?.message ?? error.message }}
        </div>
        <div class="mt-1 text-xs opacity-70">
          <code>GET /health</code> reports which backend is in use and why it failed.
        </div>
      </div>
    </div>

    <template v-else>
      <div class="flex flex-wrap items-end gap-3">
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

        <label class="form-control">
          <div class="label py-1">
            <span class="label-text text-xs">Speed — {{ speed.toFixed(2) }}×</span>
          </div>
          <input
            v-model.number="speed"
            type="range"
            min="0.7"
            max="1.4"
            step="0.05"
            class="range range-xs w-40"
          >
        </label>

        <button class="btn btn-sm" :disabled="previewing" @click="play">
          <span v-if="previewing" class="loading loading-spinner loading-xs" />
          {{ previewing ? 'Rendering…' : 'Preview' }}
        </button>
      </div>

      <audio v-if="audioUrl" id="voice-preview" :src="audioUrl" controls class="h-9 w-full max-w-md" />

      <p v-if="previewError" class="text-error text-xs">
        {{ previewError }}
      </p>
    </template>
  </div>
</template>

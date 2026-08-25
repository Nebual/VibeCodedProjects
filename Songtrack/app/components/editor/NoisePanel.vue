<script setup lang="ts">
import type { EditFilter, EditList, NoiseRegion } from '#shared/types'
import type { ResolvedSegment } from '#shared/utils/timeline'

const props = defineProps<{
  songId: string
  /** The current full/original take stack, resolved to segments — where windowed previews read audio from. */
  segments: ResolvedSegment[]
  noiseRegion: NoiseRegion | null
  /** Where windowed 15s previews should center — the current playhead, typically. */
  previewCenter: number
}>()

const emit = defineEmits<{
  'select-ambience': []
  'clear-ambience': []
}>()

const filters = defineModel<EditFilter[]>('filters', { required: true })
const gain = defineModel<EditList['gain']>('gain')

function findFilter<T extends EditFilter['type']>(type: T) {
  return filters.value.find((f): f is Extract<EditFilter, { type: T }> => f.type === type)
}

const initialAfftdn = findFilter('afftdn')
const noiseReductionEnabled = ref(!!initialAfftdn)
const nr = ref(initialAfftdn?.nr ?? 10)
const gs = ref(initialAfftdn?.gs ?? 6)

const highpassEnabled = ref(!!findFilter('highpass'))

const initialNotch = findFilter('notch')
const enabledNotchFreqs = ref<number[]>(initialNotch?.freqs ?? [])
const notchCandidates = ref<number[]>([])
const detectingNotch = ref(false)

const agateEnabled = ref(!!findFilter('agate'))

// Defaults on for old and new songs alike — `gain` being unset is indistinguishable from
// "never touched", and given how much of this app is about fixing too-quiet audio, defaulting
// to normalized is the friendlier behavior.
const loudnormEnabled = ref(gain.value ? gain.value.mode === 'loudnorm' : true)
const targetLufs = ref(gain.value?.targetLufs ?? -16)

const displayedChips = computed(() =>
  [...new Set([...notchCandidates.value, ...enabledNotchFreqs.value])].sort((a, b) => a - b),
)

function toggleNotch(freq: number) {
  enabledNotchFreqs.value = enabledNotchFreqs.value.includes(freq)
    ? enabledNotchFreqs.value.filter(f => f !== freq)
    : [...enabledNotchFreqs.value, freq]
}

const ownedFilters = computed<EditFilter[]>(() => {
  const list: EditFilter[] = []
  if (noiseReductionEnabled.value) {
    list.push({ type: 'afftdn', nr: nr.value, gs: gs.value, noiseRegion: props.noiseRegion ?? undefined })
  }
  if (enabledNotchFreqs.value.length) {
    list.push({ type: 'notch', freqs: [...enabledNotchFreqs.value].sort((a, b) => a - b), q: 30 })
  }
  if (highpassEnabled.value) {
    list.push({ type: 'highpass', freq: 35 })
  }
  if (agateEnabled.value) {
    list.push({ type: 'agate', threshold: -50, ratio: 2 })
  }
  return list
})

watch(ownedFilters, (value) => { filters.value = value }, { immediate: true, deep: true })
watch([loudnormEnabled, targetLufs], ([enabled, target]) => {
  gain.value = enabled ? { mode: 'loudnorm', targetLufs: target } : undefined
}, { immediate: true })

async function detectNotches() {
  if (!props.noiseRegion) return
  detectingNotch.value = true
  try {
    const res = await $fetch<{ frequencies: number[] }>(`/api/songs/${props.songId}/auto-notch`, {
      method: 'POST',
      body: { segments: props.segments, region: props.noiseRegion },
    })
    notchCandidates.value = res.frequencies
  } finally {
    detectingNotch.value = false
  }
}

// --- 15s A/B preview, per the "every option previews on a 15-second window" rule ---
const previewState = ref<'idle' | 'processed' | 'original' | 'removed'>('idle')
const busyKind = ref<'idle' | 'processed' | 'original' | 'removed'>('idle')
const previewPlayer = usePreviewPlayer()

async function fetchWindowBlob(previewFilters: EditFilter[] | undefined, previewGain: EditList['gain'] | undefined, audition: boolean): Promise<Blob> {
  return await $fetch<Blob>(`/api/songs/${props.songId}/preview-window`, {
    method: 'POST',
    body: { segments: props.segments, center: props.previewCenter, padding: 7.5, filters: previewFilters, gain: previewGain, audition },
  })
}

async function playPreview(kind: 'processed' | 'original' | 'removed') {
  busyKind.value = kind
  previewState.value = kind
  try {
    const blob = kind === 'original'
      ? await fetchWindowBlob(undefined, undefined, false)
      : kind === 'removed'
        ? await fetchWindowBlob(ownedFilters.value, undefined, true)
        : await fetchWindowBlob(ownedFilters.value, gain.value, false)
    await previewPlayer.loadAndPlay(blob)
  } catch {
    previewState.value = 'idle'
  } finally {
    busyKind.value = 'idle'
  }
}
</script>

<template>
  <div class="card bg-base-100 shadow-sm p-4 flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="font-medium">Noise reduction</h2>
      <input v-model="noiseReductionEnabled" type="checkbox" class="toggle toggle-primary" aria-label="Enable noise reduction">
    </div>

    <template v-if="noiseReductionEnabled">
      <div class="flex items-center gap-2 flex-wrap">
        <p v-if="!noiseRegion" class="text-xs text-warning flex-1 min-w-0">
          No ambience sample was captured for this recording — denoise will track the noise floor
          continuously instead of using a learned profile.
        </p>
        <span v-else class="flex-1" />
        <button class="btn btn-xs" @click="emit('select-ambience')">
          {{ noiseRegion ? 'Reselect ambience' : 'Select ambience' }}
        </button>
        <button v-if="noiseRegion" class="btn btn-xs btn-ghost" @click="emit('clear-ambience')">
          Clear
        </button>
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-sm flex justify-between"><span>Strength</span><span>{{ nr }}dB</span></label>
        <input v-model.number="nr" type="range" class="range range-sm" min="6" max="32" step="1" aria-label="Noise reduction strength">
        <div class="flex justify-between text-xs text-base-content/50"><span>Gentle</span><span>Strong</span></div>
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-sm flex justify-between"><span>Smoothing</span><span>{{ gs }}</span></label>
        <input v-model.number="gs" type="range" class="range range-sm" min="0" max="20" step="1">
        <p class="text-xs text-base-content/50">Higher values reduce watery/chirpy artifacts on sustained notes.</p>
      </div>

      <div class="flex flex-wrap gap-2">
        <button class="btn btn-xs" :disabled="busyKind === 'removed'" @click="playPreview('removed')">
          {{ busyKind === 'removed' ? 'Loading…' : "Listen to what's removed" }}
        </button>
        <button class="btn btn-xs" :disabled="busyKind === 'original'" @click="playPreview('original')">
          {{ busyKind === 'original' ? 'Loading…' : 'Preview original' }}
        </button>
        <button class="btn btn-xs btn-primary" :disabled="busyKind === 'processed'" @click="playPreview('processed')">
          {{ busyKind === 'processed' ? 'Loading…' : 'Preview with settings' }}
        </button>
      </div>
      <MiniPlayer
        v-if="previewState !== 'idle'"
        :is-playing="previewPlayer.isPlaying.value"
        :current-time="previewPlayer.currentTime.value"
        :duration="previewPlayer.duration.value"
        @toggle="previewPlayer.toggle"
        @seek="previewPlayer.seek"
      />
      <p class="text-xs text-base-content/50 -mt-2">
        If what's removed sounds like piano rather than just noise, dial the strength back.
      </p>

      <label class="label cursor-pointer justify-start gap-2 p-0">
        <input v-model="highpassEnabled" type="checkbox" class="toggle toggle-sm">
        <span class="label-text text-sm">Cut rumble below 35Hz</span>
      </label>

      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">Hum / whine</span>
          <button class="btn btn-xs" :disabled="!noiseRegion || detectingNotch" @click="detectNotches">
            {{ detectingNotch ? 'Analyzing…' : 'Detect' }}
          </button>
        </div>
        <div v-if="displayedChips.length" class="flex flex-wrap gap-1">
          <button
            v-for="freq in displayedChips"
            :key="freq"
            type="button"
            class="badge cursor-pointer"
            :class="enabledNotchFreqs.includes(freq) ? 'badge-primary' : 'badge-outline'"
            @click="toggleNotch(freq)"
          >
            {{ freq }} Hz
          </button>
        </div>
        <p v-else class="text-xs text-base-content/50">No tonal hum detected yet.</p>
      </div>

      <div class="divider my-0" />
    </template>

    <label class="label cursor-pointer justify-start gap-2 p-0">
      <input v-model="agateEnabled" type="checkbox" class="toggle toggle-sm">
      <span class="label-text text-sm">Gate quiet gaps between phrases</span>
    </label>
    <p v-if="agateEnabled" class="text-xs text-warning">
      Can clip the tail of long decays — listen to a preview before saving.
    </p>

    <label class="label cursor-pointer justify-start gap-2 p-0">
      <input v-model="loudnormEnabled" type="checkbox" class="toggle toggle-sm">
      <span class="label-text text-sm">Normalize level</span>
    </label>
    <div v-if="loudnormEnabled" class="flex flex-col gap-1">
      <label class="text-sm flex justify-between"><span>Target loudness</span><span>{{ targetLufs }} LUFS</span></label>
      <input v-model.number="targetLufs" type="range" class="range range-sm" min="-24" max="-6" step="1">
    </div>
  </div>
</template>

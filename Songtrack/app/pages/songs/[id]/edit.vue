<script setup lang="ts">
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/plugins/regions'
import type { Region } from 'wavesurfer.js/plugins/regions'
import { ArrowUturnLeftIcon, ArrowUturnRightIcon, ScissorsIcon } from '@heroicons/vue/24/outline'
import type { EditFilter, EditList, NoiseRegion } from '#shared/types'
import type { ResolvedSegment, TimelineTake } from '#shared/utils/timeline'

interface SongDetail {
  id: string
  title: string
  durationS: number | null
  editList: EditList
  noiseRegion: NoiseRegion | null
}

interface TakeInfo {
  id: string
  timelineStart: number
  durationS: number | null
  ordinal: number
}

interface PeaksResponse {
  data: number[]
}

interface KeepRange { start: number, end: number }

definePageMeta({ hidePlayerBar: true })

const route = useRoute()
const songId = route.params.id as string

const { data: song } = await useFetch<SongDetail>(`/api/songs/${songId}`)
const { data: takesData } = await useFetch<TakeInfo[]>(`/api/songs/${songId}/takes`)

if (!song.value) {
  throw createError({ statusCode: 404, statusMessage: 'Song not found' })
}

const containerRef = useTemplateRef<HTMLDivElement>('waveformContainer')
let ws: WaveSurfer | null = null
let regionsPlugin: RegionsPlugin | null = null
let disableDragSelection: (() => void) | null = null
let marqueeRegion: Region | null = null

const monitorGain = useMonitorGain()
let masterGainNode: GainNode | null = null
let masterPeaksFloat: Float32Array | null = null

const isReady = ref(false)
const isPlaying = ref(false)
const currentTime = ref(0)
const loadError = ref<string | null>(null)

const baseSegments = ref<ResolvedSegment[]>(song.value.editList.segments)
const keepRanges = ref<KeepRange[]>([])
const masterDuration = ref(song.value.durationS ?? 0)

const filters = ref<EditFilter[]>(structuredClone(song.value.editList.filters))
const gain = ref<EditList['gain']>(structuredClone(song.value.editList.gain))
const noiseRegionRef = ref<NoiseRegion | null>(structuredClone(song.value.noiseRegion))
const initialFiltersJson = JSON.stringify(song.value.editList.filters)
const initialGainJson = JSON.stringify(song.value.editList.gain ?? null)

const takesEnabled = ref<Record<string, boolean>>({})
watchEffect(() => {
  for (const t of takesData.value ?? []) {
    if (!(t.id in takesEnabled.value)) takesEnabled.value[t.id] = true
  }
})
const showTakesPanel = computed(() => (takesData.value?.length ?? 0) > 1)

interface HistoryEntry { baseSegments: ResolvedSegment[], keepRanges: KeepRange[] }
const history = ref<HistoryEntry[]>([])
const historyIndex = ref(-1)
const canUndo = computed(() => historyIndex.value > 0)
const canRedo = computed(() => historyIndex.value < history.value.length - 1)

function snapshot(): HistoryEntry {
  return {
    baseSegments: baseSegments.value.map(s => ({ ...s })),
    keepRanges: keepRanges.value.map(r => ({ ...r })),
  }
}

function pushHistory() {
  history.value = history.value.slice(0, historyIndex.value + 1)
  history.value.push(snapshot())
  historyIndex.value = history.value.length - 1
}

function restore(entry: HistoryEntry) {
  baseSegments.value = entry.baseSegments.map(s => ({ ...s }))
  keepRanges.value = entry.keepRanges.map(r => ({ ...r }))
  renderRegions()
}

function undo() {
  if (!canUndo.value) return
  historyIndex.value--
  restore(history.value[historyIndex.value]!)
}
function redo() {
  if (!canRedo.value) return
  historyIndex.value++
  restore(history.value[historyIndex.value]!)
}

function subtractRange(ranges: KeepRange[], cut: KeepRange): KeepRange[] {
  const result: KeepRange[] = []
  for (const r of ranges) {
    if (cut.end <= r.start || cut.start >= r.end) {
      result.push(r)
      continue
    }
    if (cut.start > r.start) result.push({ start: r.start, end: cut.start })
    if (cut.end < r.end) result.push({ start: cut.end, end: r.end })
  }
  return result.filter(r => r.end - r.start > 0.05)
}

function peaksToFloatArray(data: number[]): Float32Array {
  const arr = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) arr[i] = data[i]! / 128
  return arr
}

function regionColorFor(index: number): string {
  const colors = ['rgba(34,197,94,0.25)', 'rgba(59,130,246,0.25)', 'rgba(168,85,247,0.25)']
  return colors[index % colors.length]!
}

function makeDeleteButton(onClick: () => void): HTMLElement {
  const btn = document.createElement('button')
  btn.textContent = '✕'
  btn.style.cssText = 'position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:4px;width:18px;height:18px;font-size:11px;line-height:1;cursor:pointer;'
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return btn
}

function renderRegions() {
  if (!regionsPlugin) return
  // A single clearRegions() wipes every region in the plugin, so the noise-profile
  // region below must be redrawn here too, not in a separate call site.
  regionsPlugin.clearRegions()
  const sorted = [...keepRanges.value].sort((a, b) => a.start - b.start)
  sorted.forEach((range, i) => {
    const region = regionsPlugin!.addRegion({
      id: `keep-${i}`,
      start: range.start,
      end: range.end,
      color: regionColorFor(i),
      drag: false,
      resize: true,
    })
    if (sorted.length > 1) {
      region.element?.appendChild(makeDeleteButton(() => {
        keepRanges.value = keepRanges.value.filter(r => !(r.start === range.start && r.end === range.end))
        pushHistory()
        renderRegions()
      }))
    }
  })

  if (noiseRegionRef.value) {
    const region = regionsPlugin.addRegion({
      id: 'noise-profile',
      start: noiseRegionRef.value.start,
      end: noiseRegionRef.value.end,
      color: 'rgba(251,191,36,0.35)',
      drag: true,
      resize: true,
    })
    region.element?.setAttribute('data-region-id', 'noise-profile')
  }
}

function syncKeepRangesFromRegions() {
  if (!regionsPlugin) return
  const ranges = regionsPlugin.getRegions()
    .filter(r => r.id.startsWith('keep-'))
    .map(r => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start)
  keepRanges.value = ranges
  pushHistory()
}

const hasMarquee = ref(false)
function clearMarquee() {
  marqueeRegion?.remove()
  marqueeRegion = null
  hasMarquee.value = false
}

const selectingAmbience = ref(false)
function startSelectingAmbience() {
  clearMarquee()
  selectingAmbience.value = true
}
function clearAmbience() {
  noiseRegionRef.value = null
  renderRegions()
}

function removeSelection() {
  if (!marqueeRegion) return
  const cut = { start: marqueeRegion.start, end: marqueeRegion.end }
  keepRanges.value = subtractRange(keepRanges.value, cut)
  clearMarquee()
  pushHistory()
  renderRegions()
}

/**
 * The Regions plugin's own `enableDragSelection` listens for pointerdown on
 * the waveform wrapper — but every region element sets `pointer-events: all`
 * on itself (even non-draggable ones), which swallows that pointerdown
 * whenever a drag starts on top of an existing region. Since the default
 * state is one big "keep" region spanning the whole waveform, that made it
 * impossible to ever start a selection to cut out a middle section. A
 * capture-phase listener on the wrapper fires before any region's own
 * bubble-phase handler, regardless of which element hit-testing lands on.
 */
function setupCustomDragSelection(wavesurfer: WaveSurfer, regions: RegionsPlugin): () => void {
  const wrapper = wavesurfer.getWrapper()
  let dragStartTime: number | null = null
  let ambienceDragRegion: Region | null = null

  function xToTime(clientX: number): number {
    const rect = wrapper.getBoundingClientRect()
    const fraction = (clientX - rect.left) / rect.width
    return Math.max(0, Math.min(masterDuration.value, fraction * masterDuration.value))
  }

  function onAmbiencePointerMove(e: PointerEvent) {
    if (dragStartTime === null) return
    const current = xToTime(e.clientX)
    const start = Math.min(dragStartTime, current)
    const end = Math.max(dragStartTime, current)
    if (end - start < 0.05) return
    if (!ambienceDragRegion) {
      ambienceDragRegion = regions.addRegion({ id: 'ambience-select', start, end, color: 'rgba(251,191,36,0.35)', drag: false, resize: false })
    } else {
      ambienceDragRegion.setOptions({ start, end })
    }
  }

  function onAmbiencePointerUp() {
    window.removeEventListener('pointermove', onAmbiencePointerMove)
    if (dragStartTime !== null && ambienceDragRegion) {
      noiseRegionRef.value = { start: ambienceDragRegion.start, end: ambienceDragRegion.end }
    }
    ambienceDragRegion?.remove()
    ambienceDragRegion = null
    dragStartTime = null
    selectingAmbience.value = false
    renderRegions()
  }

  function onPointerDown(e: PointerEvent) {
    if (selectingAmbience.value) {
      e.preventDefault()
      e.stopPropagation()
      dragStartTime = xToTime(e.clientX)
      window.addEventListener('pointermove', onAmbiencePointerMove)
      window.addEventListener('pointerup', onAmbiencePointerUp, { once: true })
      return
    }
    const target = e.target as HTMLElement
    if (target.closest('[part*="region-handle"]')) return // let native resize proceed
    if (target.closest('[data-region-id="noise-profile"]')) return // let native drag-to-move proceed
    e.preventDefault()
    e.stopPropagation()
    dragStartTime = xToTime(e.clientX)
    clearMarquee()
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  function onPointerMove(e: PointerEvent) {
    if (dragStartTime === null) return
    const current = xToTime(e.clientX)
    const start = Math.min(dragStartTime, current)
    const end = Math.max(dragStartTime, current)
    if (end - start < 0.05) return
    if (!marqueeRegion) {
      marqueeRegion = regions.addRegion({ id: 'marquee', start, end, color: 'rgba(239,68,68,0.35)', drag: false, resize: false })
      hasMarquee.value = true
    } else {
      marqueeRegion.setOptions({ start, end })
    }
  }

  function onPointerUp() {
    dragStartTime = null
    window.removeEventListener('pointermove', onPointerMove)
  }

  wrapper.addEventListener('pointerdown', onPointerDown, { capture: true })
  return () => wrapper.removeEventListener('pointerdown', onPointerDown, { capture: true })
}

onMounted(() => {
  if (!import.meta.client || !containerRef.value || !song.value) return

  ;(async () => {
    try {
      const peaks = await $fetch<PeaksResponse>(`/api/songs/${songId}/peaks`)
      const duration = song.value!.durationS ?? undefined
      masterPeaksFloat = peaksToFloatArray(peaks.data)

      ws = WaveSurfer.create({
        container: containerRef.value!,
        url: `/api/songs/${songId}/audio`,
        peaks: [masterPeaksFloat],
        duration,
        height: 96,
        waveColor: 'oklch(70% 0.02 250)',
        progressColor: 'oklch(55% 0.15 250)',
        cursorColor: 'oklch(70% 0.2 30)',
      })

      regionsPlugin = ws.registerPlugin(RegionsPlugin.create())
      disableDragSelection = setupCustomDragSelection(ws, regionsPlugin)

      regionsPlugin.on('region-updated', (region) => {
        if (region.id.startsWith('keep-')) syncKeepRangesFromRegions()
        if (region.id === 'noise-profile') noiseRegionRef.value = { start: region.start, end: region.end }
      })

      ws.on('ready', (dur) => {
        masterDuration.value = dur
        keepRanges.value = [{ start: 0, end: dur }]
        pushHistory()
        renderRegions()
        isReady.value = true
        masterGainNode = monitorGain.wrapElement(ws!.getMediaElement())
        masterGainNode.gain.value = monitorGain.gainForPeaks(masterPeaksFloat!)
      })
      ws.on('play', () => { isPlaying.value = true })
      ws.on('pause', () => { isPlaying.value = false })
      ws.on('timeupdate', (t) => { currentTime.value = t })
      ws.on('error', (e) => { loadError.value = String(e) })
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : 'Could not load the waveform.'
    }
  })()
})

function onKeydown(e: KeyboardEvent) {
  if (isEditableTarget(e.target)) return
  const modKey = e.metaKey || e.ctrlKey
  if (modKey && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
  } else if (e.code === 'Space' && isReady.value) {
    e.preventDefault()
    togglePlay()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // Stop any playback started from the song list before navigating in here — its footer
  // player is hidden on this route (see hidePlayerBar), so lingering audio would be inaudible
  // to control.
  usePlayer().pause()
})

watch(monitorGain.targetLevelDb, () => {
  if (masterGainNode && masterPeaksFloat) masterGainNode.gain.value = monitorGain.gainForPeaks(masterPeaksFloat)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  disableDragSelection?.()
  ws?.destroy()
})

function togglePlay() {
  ws?.playPause()
}

// --- Auto-trim ---
interface AutoTrimProposal { startCut: number, endCut: number, noiseFloorDb: number, tailPadS: number, fadeOutMs: number }
const autoTrimProposal = ref<AutoTrimProposal | null>(null)
const autoTrimLoading = ref(false)
const previewingWindow = ref<'start' | 'end' | null>(null)
const cutPreviewPlayer = usePreviewPlayer()
const CUT_PREVIEW_PADDING = 3

function cutPreviewCenter(which: 'start' | 'end'): number {
  return which === 'start' ? autoTrimProposal.value!.startCut : masterDuration.value - autoTrimProposal.value!.endCut
}

// The window is only symmetric around the cut when there's enough audio on both sides to pad
// evenly — trimming e.g. 1s off the very start clamps the window's actual start to 0, so the
// cut sits wherever `center` really falls within the *actual* played duration, not at 50%.
const cutMarkerFraction = computed(() => {
  if (!previewingWindow.value || !autoTrimProposal.value) return 0.5
  const center = cutPreviewCenter(previewingWindow.value)
  const clipStart = Math.max(0, center - CUT_PREVIEW_PADDING)
  const clipDuration = cutPreviewPlayer.duration.value
  if (!clipDuration) return 0.5
  return Math.min(1, Math.max(0, (center - clipStart) / clipDuration))
})

async function fetchAutoTrim() {
  autoTrimLoading.value = true
  try {
    autoTrimProposal.value = await $fetch<AutoTrimProposal>(`/api/songs/${songId}/auto-trim`, { method: 'POST' })
  } finally {
    autoTrimLoading.value = false
  }
}

async function previewCut(which: 'start' | 'end') {
  if (!autoTrimProposal.value) return
  if (previewingWindow.value === which) {
    cutPreviewPlayer.stop()
    previewingWindow.value = null
    return
  }
  previewingWindow.value = which
  const center = cutPreviewCenter(which)
  try {
    const blob = await $fetch<Blob>(`/api/songs/${songId}/preview-window`, {
      method: 'POST',
      body: { center, padding: CUT_PREVIEW_PADDING, clickAtCenter: true },
    })
    await cutPreviewPlayer.loadAndPlay(blob)
  } catch {
    previewingWindow.value = null
  }
}

function applyAutoTrim() {
  if (!autoTrimProposal.value) return
  const { startCut, endCut } = autoTrimProposal.value
  let ranges = keepRanges.value
  if (startCut > 0) ranges = subtractRange(ranges, { start: 0, end: startCut })
  if (endCut > 0) ranges = subtractRange(ranges, { start: masterDuration.value - endCut, end: masterDuration.value })
  keepRanges.value = ranges
  autoTrimProposal.value = null
  pushHistory()
  renderRegions()
}

// --- Takes panel ---
const rebuildingTakes = ref(false)
async function toggleTake(takeId: string) {
  if (!takesData.value) return
  takesEnabled.value[takeId] = !takesEnabled.value[takeId]

  const enabledTakes: TimelineTake[] = takesData.value
    .filter(t => takesEnabled.value[t.id])
    .map(t => ({ id: t.id, timelineStart: t.timelineStart, duration: t.durationS ?? 0 }))

  if (enabledTakes.length === 0) {
    takesEnabled.value[takeId] = true // can't disable every take
    return
  }

  rebuildingTakes.value = true
  try {
    const newSegments = resolveTimeline(enabledTakes)
    const newDuration = segmentsDuration(newSegments)

    const preview = await $fetch<{ url: string }>(`/api/songs/${songId}/preview`, {
      method: 'POST',
      body: { editList: { segments: newSegments, filters: filters.value } },
    })

    baseSegments.value = newSegments
    masterDuration.value = newDuration
    keepRanges.value = [{ start: 0, end: newDuration }]
    pushHistory()

    ws?.load(preview.url, undefined, newDuration)
    await new Promise<void>((resolve) => {
      ws?.once('ready', () => resolve())
    })
    renderRegions()
  } finally {
    rebuildingTakes.value = false
  }
}

// --- Preview / Save ---
const finalEditList = computed<EditList>(() => ({
  segments: applyKeepRanges(baseSegments.value, keepRanges.value),
  filters: filters.value,
  gain: gain.value,
  fades: song.value!.editList.fades,
}))

const previewing = ref(false)
const previewUrl = ref<string | null>(null)
async function runPreview() {
  previewing.value = true
  previewUrl.value = null
  try {
    const res = await $fetch<{ url: string }>(`/api/songs/${songId}/preview`, {
      method: 'POST',
      body: { editList: finalEditList.value },
    })
    previewUrl.value = res.url
  } finally {
    previewing.value = false
  }
}

const saving = ref(false)
const saveError = ref<string | null>(null)
const router = useRouter()
async function runSave() {
  saving.value = true
  saveError.value = null
  try {
    await $fetch(`/api/songs/${songId}/edit`, {
      method: 'POST',
      body: { editList: finalEditList.value, noiseRegion: noiseRegionRef.value },
    })
    router.push(`/songs/${songId}`)
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Could not save changes.'
  } finally {
    saving.value = false
  }
}

const hasEdits = computed(() => {
  if (JSON.stringify(filters.value) !== initialFiltersJson) return true
  if (JSON.stringify(gain.value ?? null) !== initialGainJson) return true
  if (keepRanges.value.length !== 1) return true
  const r = keepRanges.value[0]
  return !r || Math.abs(r.start) > 0.05 || Math.abs(r.end - masterDuration.value) > 0.05
})
</script>

<template>
  <div class="max-w-3xl mx-auto p-4 flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-semibold">Edit — {{ song?.title }}</h1>
      <div class="flex gap-2">
        <button class="btn btn-sm btn-circle" :disabled="!canUndo" aria-label="Undo" @click="undo">
          <ArrowUturnLeftIcon class="w-4 h-4" />
        </button>
        <button class="btn btn-sm btn-circle" :disabled="!canRedo" aria-label="Redo" @click="redo">
          <ArrowUturnRightIcon class="w-4 h-4" />
        </button>
      </div>
    </div>

    <p v-if="loadError" class="alert alert-error text-sm">{{ loadError }}</p>

    <div class="bg-base-300 rounded-box overflow-hidden relative">
      <div ref="waveformContainer" />
      <div v-if="!isReady" class="absolute inset-0 flex items-center justify-center">
        <span class="loading loading-spinner" />
      </div>
    </div>

    <div class="flex items-center gap-2">
      <button class="btn btn-sm btn-circle" :disabled="!isReady" @click="togglePlay">
        {{ isPlaying ? '⏸' : '▶' }}
      </button>
      <span class="text-sm text-base-content/60 tabular-nums">{{ formatDuration(currentTime) }}</span>
      <button v-if="hasMarquee" class="btn btn-sm btn-error gap-1 ml-auto" @click="removeSelection">
        <ScissorsIcon class="w-4 h-4" /> Remove selection
      </button>
    </div>
    <p class="text-xs text-base-content/50 -mt-2">
      Drag on the waveform to select a range, then remove it. Drag a region's edge to trim.
    </p>

    <div class="flex items-center gap-2">
      <span class="text-sm text-base-content/60 whitespace-nowrap">Preview loudness</span>
      <input
        v-model.number="monitorGain.targetLevelDb.value"
        type="range"
        class="range range-xs w-32"
        min="-30"
        max="-6"
        step="1"
        aria-label="Preview loudness target"
      >
      <span class="text-xs text-base-content/50 tabular-nums">{{ monitorGain.targetLevelDb.value }}dB</span>
    </div>

    <!-- Auto-trim -->
    <div class="card bg-base-100 shadow-sm p-4">
      <div class="flex items-center justify-between mb-2">
        <h2 class="font-medium">Auto-trim</h2>
        <button class="btn btn-sm" :disabled="autoTrimLoading" @click="fetchAutoTrim">
          {{ autoTrimLoading ? 'Analyzing…' : 'Suggest trim' }}
        </button>
      </div>
      <div v-if="autoTrimProposal" class="flex flex-col gap-2 text-sm">
        <p class="text-base-content/70">
          Proposed: cut {{ formatDuration(autoTrimProposal.startCut) }} from the start and
          {{ formatDuration(autoTrimProposal.endCut) }} from the end (noise floor ≈
          {{ autoTrimProposal.noiseFloorDb.toFixed(0) }}dB). The end cut keeps a
          {{ autoTrimProposal.tailPadS }}s pad past where the decay flattens, so a held chord isn't clipped.
        </p>
        <div class="flex gap-2">
          <button class="btn btn-xs" @click="previewCut('start')">
            {{ previewingWindow === 'start' ? 'Stop' : 'Preview start cut' }}
          </button>
          <button class="btn btn-xs" @click="previewCut('end')">
            {{ previewingWindow === 'end' ? 'Stop' : 'Preview end cut' }}
          </button>
          <button class="btn btn-xs btn-primary" @click="applyAutoTrim">Apply</button>
          <button class="btn btn-xs btn-ghost" @click="autoTrimProposal = null">Dismiss</button>
        </div>
        <MiniPlayer
          v-if="previewingWindow"
          :is-playing="cutPreviewPlayer.isPlaying.value"
          :current-time="cutPreviewPlayer.currentTime.value"
          :duration="cutPreviewPlayer.duration.value"
          :marker-fraction="cutMarkerFraction"
          @toggle="cutPreviewPlayer.toggle"
          @seek="cutPreviewPlayer.seek"
        />
        <p class="text-xs text-base-content/50">
          The marker on the seek bar is the cut point — the clip is padded evenly on both sides of it.
        </p>
      </div>
    </div>

    <!-- Noise reduction -->
    <EditorNoisePanel
      v-model:filters="filters"
      v-model:gain="gain"
      :song-id="songId"
      :noise-region="noiseRegionRef"
      :preview-center="currentTime"
      @select-ambience="startSelectingAmbience"
      @clear-ambience="clearAmbience"
    />
    <p v-if="selectingAmbience" class="text-xs text-warning -mt-2">
      Drag on the waveform to set the ambience sample.
    </p>
    <!-- todo: only show this if there is an amber region -->
    <p v-else class="text-xs text-base-content/50 -mt-2">
      Drag the amber region on the waveform to adjust which part of the recording is sampled as the noise profile.
    </p>

    <!-- Takes -->
    <div v-if="showTakesPanel" class="card bg-base-100 shadow-sm p-4">
      <h2 class="font-medium mb-2">Takes</h2>
      <p class="text-xs text-base-content/50 mb-2">
        Turning off a punch-in reveals whatever take was underneath it. This resets any trims you've made.
      </p>
      <ul class="flex flex-col gap-1">
        <li v-for="t in takesData" :key="t.id" class="flex items-center gap-2">
          <input
            type="checkbox"
            class="toggle toggle-sm"
            :checked="takesEnabled[t.id]"
            :disabled="rebuildingTakes"
            @change="toggleTake(t.id)"
          >
          <span class="text-sm">
            Take at {{ formatDuration(t.timelineStart) }} ({{ formatDuration(t.durationS ?? 0) }})
          </span>
        </li>
      </ul>
    </div>

    <!-- Preview / Save -->
    <div class="flex flex-col gap-2">
      <audio v-if="previewUrl" controls class="w-full" :src="previewUrl" />
      <p v-if="saveError" class="alert alert-error text-sm">{{ saveError }}</p>
      <div class="flex gap-2">
        <button class="btn btn-outline" :disabled="previewing || !hasEdits" @click="runPreview">
          {{ previewing ? 'Rendering…' : 'Preview edits' }}
        </button>
        <button class="btn btn-primary ml-auto" :disabled="saving || !hasEdits" @click="runSave">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>

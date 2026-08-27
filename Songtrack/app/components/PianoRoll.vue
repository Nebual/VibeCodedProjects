<script setup lang="ts">
import type { BeatGrid, TranscribedNote } from '#shared/types'

/**
 * Notes over time, drawn on a `<canvas>` like `WaveformCanvas.vue`.
 *
 * Kept directly under `app/components/` rather than in a subfolder because
 * `app/components/foo/Bar.vue` registers as `<FooBar>` — the same thing that forced
 * `WaveformCanvas.vue` out of its own subfolder.
 */
const props = defineProps<{
  notes: TranscribedNote[]
  /** Beat and bar lines to overlay. The fastest read on whether a tempo estimate is right. */
  grid?: BeatGrid | null
  /** Total seconds of material. The scroll range when zoomed in. */
  duration?: number
  /** Playhead position in seconds. */
  playhead?: number
  /** Seconds visible at once. Omit to fit everything. */
  window?: number | null
  /** Keep the playhead in view while this is true. */
  follow?: boolean
  /** Instruments to grey out — the ones muted in the player. */
  muted?: string[]
}>()

const emit = defineEmits<{ seek: [time: number] }>()

/** Left edge of the visible window, in seconds. */
const scroll = ref(0)

const totalSeconds = computed(() => {
  // The larger of the two, never just `duration`: a song whose master was cropped after being
  // transcribed still has notes past the new duration, and silently clipping them off the right
  // of the roll looks like the transcription lost them.
  const fromNotes = props.notes.length ? Math.max(...props.notes.map(n => n.end)) : 0
  return Math.max(1, props.duration ?? 0, fromNotes)
})

/** Seconds actually drawn across the canvas. */
const visible = computed(() => Math.min(props.window || totalSeconds.value, totalSeconds.value))

const maxScroll = computed(() => Math.max(0, totalSeconds.value - visible.value))

function scrollTo(seconds: number) {
  scroll.value = Math.min(maxScroll.value, Math.max(0, seconds))
}

// Keep the playhead in view without lurching: page forward only once it leaves the window.
watch(() => props.playhead, (t) => {
  if (!props.follow || t === undefined || !props.window) return
  const left = scroll.value
  const right = left + visible.value
  if (t < left || t > right - visible.value * 0.15) {
    scrollTo(t - visible.value * 0.3)
  }
})

defineExpose({ scrollTo })

const canvasRef = useTemplateRef<HTMLCanvasElement>('canvas')

const MIN_PITCH_SPAN = 24 // never zoom in so far that two notes fill the whole roll

/** Notes overlapping the visible window — everything else is skipped before it reaches the canvas. */
const visibleNotes = computed(() => {
  const left = scroll.value
  const right = left + visible.value
  return props.notes.filter(n => n.end >= left && n.start <= right)
})

function pitchRange(): [number, number] {
  // Ranged over ALL notes, not just the visible ones: a pitch axis that rescales as you scroll
  // makes the notes jump around and is unreadable.
  if (props.notes.length === 0) return [48, 84]
  let lo = Infinity
  let hi = -Infinity
  for (const n of props.notes) {
    if (n.pitch < lo) lo = n.pitch
    if (n.pitch > hi) hi = n.pitch
  }
  const pad = Math.max(0, MIN_PITCH_SPAN - (hi - lo)) / 2
  return [Math.floor(lo - pad - 1), Math.ceil(hi + pad + 1)]
}

/** Distinct hues per instrument, so a mixed transcription is readable at a glance. */
const INSTRUMENT_HUES = [250, 30, 140, 320, 90, 200, 60, 0]
function hueFor(instrument: string): number {
  let hash = 0
  for (let i = 0; i < instrument.length; i++) hash = (hash * 31 + instrument.charCodeAt(i)) | 0
  return INSTRUMENT_HUES[Math.abs(hash) % INSTRUMENT_HUES.length]!
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(1, Math.floor(rect.width * dpr))
  const height = Math.max(1, Math.floor(rect.height * dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)

  const left = scroll.value
  const seconds = visible.value
  const [lo, hi] = pitchRange()
  const pitches = Math.max(1, hi - lo)
  const rowHeight = height / pitches
  const x = (t: number) => ((t - left) / seconds) * width
  const y = (pitch: number) => height - ((pitch - lo) / pitches) * height

  // --- grid overlay, underneath the notes ---
  if (props.grid) {
    const beat = 60 / props.grid.bpm
    const barDuration = beat * props.grid.beatsPerBar

    ctx.strokeStyle = 'oklch(60% 0.02 250 / 0.25)'
    ctx.lineWidth = dpr
    const firstBeat = props.grid.firstDownbeat % beat
    for (let t = firstBeat + Math.floor((left - firstBeat) / beat) * beat; t <= left + seconds; t += beat) {
      if (t < 0) continue
      ctx.beginPath()
      ctx.moveTo(Math.floor(x(t)) + 0.5, 0)
      ctx.lineTo(Math.floor(x(t)) + 0.5, height)
      ctx.stroke()
    }

    // Barlines are what actually reveal a wrong estimate: with a correct tempo the onsets
    // cluster on the lines, and with a half-time one every other line sits in empty space.
    ctx.strokeStyle = 'oklch(70% 0.12 30 / 0.65)'
    ctx.lineWidth = Math.max(1, dpr * 1.5)
    for (const t of barLinesFor(props.grid, left + seconds)) {
      if (t < left) continue
      ctx.beginPath()
      ctx.moveTo(Math.floor(x(t)) + 0.5, 0)
      ctx.lineTo(Math.floor(x(t)) + 0.5, height)
      ctx.stroke()
    }
  }

  // --- notes ---
  for (const note of visibleNotes.value) {
    const x0 = x(note.start)
    const x1 = Math.max(x0 + dpr, x(note.end))
    const isMuted = props.muted?.includes(note.instrument)
    ctx.fillStyle = isMuted
      ? `oklch(55% 0.03 ${hueFor(note.instrument)} / 0.35)`
      : `oklch(68% 0.16 ${hueFor(note.instrument)})`
    ctx.fillRect(x0, y(note.pitch) - rowHeight, x1 - x0, Math.max(dpr, rowHeight * 0.85))
  }

  // --- playhead ---
  if (props.playhead !== undefined && props.playhead >= left && props.playhead <= left + seconds) {
    ctx.fillStyle = 'oklch(85% 0.2 90)'
    ctx.fillRect(Math.floor(x(props.playhead)), 0, Math.max(1, dpr * 2), height)
  }
}

/** Local copy of the server's `barLines` — the same arithmetic, without a round trip for it. */
function barLinesFor(grid: BeatGrid, endTime: number): number[] {
  const barDuration = (60 / grid.bpm) * grid.beatsPerBar
  const lines: number[] = []
  for (let t = grid.firstDownbeat; t >= 0; t -= barDuration) lines.unshift(t)
  for (let t = grid.firstDownbeat + barDuration; t <= endTime; t += barDuration) lines.push(t)
  return lines
}

function onClick(e: MouseEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  // Relative to the visible window, not the whole piece — otherwise every click is wrong the
  // moment you zoom in.
  emit('seek', scroll.value + ((e.clientX - rect.left) / rect.width) * visible.value)
}

// Every input `draw()` reads must be listed, or the canvas silently keeps an old frame. `window`,
// `muted` and `scroll` were missing once already, which made the zoom buttons look inert whenever
// nothing was playing (the playhead was the only thing still triggering a redraw).
watch(
  () => [
    props.notes,
    props.grid,
    props.duration,
    props.playhead,
    props.window,
    props.muted,
    scroll.value,
  ],
  draw,
  { deep: true },
)
onMounted(() => {
  draw()
  const ro = new ResizeObserver(draw)
  if (canvasRef.value) ro.observe(canvasRef.value)
  onScopeDispose(() => ro.disconnect())
})
</script>

<template>
  <!-- No scrollbar of its own: it duplicated the player's scrubber and did nothing whenever the
       whole piece already fitted. Panning is the mouse wheel over the roll, or moving playback —
       the view follows the playhead. -->
  <div class="flex flex-col gap-1 h-full">
    <!-- min-h-0 is load-bearing: a flex item defaults to min-height:auto, and a canvas has an
         intrinsic size from its width/height attributes (which draw() sets in device pixels).
         Without it the canvas refuses to shrink, overflows its container, and squashes the
         scrollbar below it to zero height. -->
    <canvas
      ref="canvas"
      class="w-full flex-1 min-h-0 block cursor-crosshair rounded bg-base-300"
      data-testid="piano-roll"
      @click="onClick"
      @wheel="onWheel"
    />
  </div>
</template>

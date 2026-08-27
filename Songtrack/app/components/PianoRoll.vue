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
  /** Seconds of timeline to draw. Grows as notes stream in when this isn't given. */
  duration?: number
  /** Playhead position in seconds. */
  playhead?: number
}>()

const emit = defineEmits<{ seek: [time: number] }>()

const canvasRef = useTemplateRef<HTMLCanvasElement>('canvas')

const MIN_PITCH_SPAN = 24 // never zoom in so far that two notes fill the whole roll

const span = computed(() => {
  const seconds = props.duration
    ?? Math.max(1, ...props.notes.map(n => n.end))
  return Math.max(1, seconds)
})

function pitchRange(): [number, number] {
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

  const seconds = span.value
  const [lo, hi] = pitchRange()
  const pitches = Math.max(1, hi - lo)
  const rowHeight = height / pitches
  const x = (t: number) => (t / seconds) * width
  const y = (pitch: number) => height - ((pitch - lo) / pitches) * height

  // --- grid overlay, underneath the notes ---
  if (props.grid) {
    const beat = 60 / props.grid.bpm
    const barDuration = beat * props.grid.beatsPerBar

    ctx.strokeStyle = 'oklch(60% 0.02 250 / 0.25)'
    ctx.lineWidth = dpr
    for (let t = props.grid.firstDownbeat % beat; t <= seconds; t += beat) {
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
    for (const t of barLinesFor(props.grid, seconds)) {
      ctx.beginPath()
      ctx.moveTo(Math.floor(x(t)) + 0.5, 0)
      ctx.lineTo(Math.floor(x(t)) + 0.5, height)
      ctx.stroke()
    }
  }

  // --- notes ---
  for (const note of props.notes) {
    const left = x(note.start)
    const right = Math.max(left + dpr, x(note.end))
    ctx.fillStyle = `oklch(68% 0.16 ${hueFor(note.instrument)})`
    ctx.fillRect(left, y(note.pitch) - rowHeight, right - left, Math.max(dpr, rowHeight * 0.85))
  }

  // --- playhead ---
  if (props.playhead !== undefined) {
    ctx.fillStyle = 'oklch(85% 0.2 90)'
    ctx.fillRect(Math.floor(x(props.playhead)), 0, Math.max(1, dpr), height)
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
  emit('seek', ((e.clientX - rect.left) / rect.width) * span.value)
}

watch(() => [props.notes, props.grid, props.duration, props.playhead], draw, { deep: true })
onMounted(() => {
  draw()
  const ro = new ResizeObserver(draw)
  if (canvasRef.value) ro.observe(canvasRef.value)
  onScopeDispose(() => ro.disconnect())
})
</script>

<template>
  <canvas
    ref="canvas"
    class="w-full h-full block cursor-crosshair rounded bg-base-300"
    data-testid="piano-roll"
    @click="onClick"
  />
</template>

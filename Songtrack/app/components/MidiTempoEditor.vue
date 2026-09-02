<script setup lang="ts">
import type { BeatGrid, TranscribedNote } from '#shared/types'
import { BEATS_PER_BAR_CHOICES } from '#shared/types'
import { alignDownbeat } from '#shared/utils/grid'

/**
 * Corrects the beat grid the model detected.
 *
 * This exists because a wrong tempo is *inaudible* but ruins notation. `beat-this`'s classic
 * failure modes are half-time and double-time estimates, a 3-versus-4 beats-per-bar confusion, and
 * a first downbeat landing on the wrong beat of the bar. None of them change where the notes are in
 * wall-clock time, so the audio still sounds right and the user has no way to tell which went
 * wrong — while a half-time estimate notates every quarter note as an eighth and a misplaced
 * downbeat syncopates the whole piece across barlines.
 *
 * Everything here recomputes locally and instantly: it's all arithmetic on note events the page
 * already has, so there is no server round trip until the user asks for an engraving.
 */
const props = defineProps<{
  notes: TranscribedNote[]
  /** True while the page is waiting for the user to click a new first downbeat on the roll. */
  pickingDownbeat: boolean
  /** The grid as it stood right after transcription finished — what "Clear" reverts to. */
  original: BeatGrid | null
}>()

const grid = defineModel<BeatGrid>({ required: true })

const emit = defineEmits<{ pickDownbeat: [] }>()

const SUBDIVISIONS = [
  { value: 2, label: '8th notes' },
  { value: 4, label: '16th notes' },
  { value: 8, label: '32nd notes' },
  { value: 3, label: '8th triplets' },
]

/**
 * Every edit here stamps the grid as the user's own. That's what lets the page stop calling the
 * tempo an estimate the moment you've corrected it — otherwise the banner keeps quoting whatever
 * number is now in the box and claims it's a guess.
 */
function setGrid(patch: Partial<BeatGrid>) {
  grid.value = { ...grid.value, ...patch, source: 'user' }
}

/**
 * Slides the grid onto the notes without changing which beat starts the bar.
 *
 * This is the control that actually fixes "the music won't line up". Nudging the downbeat by a
 * 16th cannot help — a whole-step move maps the grid onto itself, leaving every note where it was
 * and moving only the barlines. Only a sub-step shift re-aligns anything.
 */
function alignToNotes() {
  const starts = props.notes.map(n => n.start)
  if (!starts.length) return
  setGrid({
    firstDownbeat: alignDownbeat(starts, grid.value.bpm, grid.value.subdivision, grid.value.firstDownbeat),
  })
}

function scaleBpm(factor: number) {
  setGrid({ bpm: clampBpm(grid.value.bpm * factor) })
  bpmText.value = String(grid.value.bpm)
}

function clampBpm(bpm: number): number {
  return Math.min(400, Math.max(20, Math.round(bpm * 100) / 100))
}

/**
 * The BPM field is edited as free text and only clamped when you leave it.
 *
 * Clamping on every keystroke made it unusable: typing "81" clamps the intermediate "8" up to the
 * minimum, so the field becomes "20" and you end up with "201". There is deliberately no `min`
 * attribute either, for the same reason — the browser fights mid-typing values too.
 */
const bpmText = ref(String(grid.value.bpm))
const editingBpm = ref(false)

watch(() => grid.value.bpm, (bpm) => {
  if (!editingBpm.value) bpmText.value = String(bpm)
})

function onBpmInput(value: string) {
  bpmText.value = value
  const parsed = Number.parseFloat(value)
  // Applied live so the barlines and onset error track what you're typing, but only once the
  // value is plausible — a half-typed "8" is not a tempo anyone means.
  if (Number.isFinite(parsed) && parsed >= 20 && parsed <= 400) {
    setGrid({ bpm: Math.round(parsed * 100) / 100 })
  }
}

function onBpmBlur() {
  editingBpm.value = false
  const parsed = Number.parseFloat(bpmText.value)
  const bpm = Number.isFinite(parsed) ? clampBpm(parsed) : grid.value.bpm
  setGrid({ bpm })
  bpmText.value = String(bpm)
}

/**
 * The downbeat field mirrors the BPM one: free text while typing, only applied once it parses to
 * something plausible, clamped to a non-negative number on blur.
 */
const downbeatText = ref(grid.value.firstDownbeat.toFixed(3))
const editingDownbeat = ref(false)

watch(() => grid.value.firstDownbeat, (v) => {
  if (!editingDownbeat.value) downbeatText.value = v.toFixed(3)
})

function onDownbeatInput(value: string) {
  downbeatText.value = value
  const parsed = Number.parseFloat(value)
  if (Number.isFinite(parsed) && parsed >= 0) setGrid({ firstDownbeat: parsed })
}

function onDownbeatBlur() {
  editingDownbeat.value = false
  const parsed = Number.parseFloat(downbeatText.value)
  const firstDownbeat = Number.isFinite(parsed) ? Math.max(0, parsed) : grid.value.firstDownbeat
  setGrid({ firstDownbeat })
  downbeatText.value = firstDownbeat.toFixed(3)
}

/**
 * Whether the downbeat has drifted from where transcription left it — by typing, picking on the
 * roll, or "Align to notes". Derived rather than tracked, so every way of moving it shows Clear.
 */
const downbeatChanged = computed(() => (
  props.original !== null && Math.abs(grid.value.firstDownbeat - props.original.firstDownbeat) > 1e-6
))

/**
 * Reverts only the downbeat, not the whole grid — a BPM correction made alongside it must survive.
 * The source only reverts to "not user's own" when nothing else was touched either; otherwise it
 * would misrepresent an edited BPM as still the model's guess.
 */
function clearDownbeat() {
  const original = props.original
  if (!original) return
  const stillMatchesOriginal = grid.value.bpm === original.bpm
    && grid.value.beatsPerBar === original.beatsPerBar
    && grid.value.subdivision === original.subdivision
  grid.value = {
    ...grid.value,
    firstDownbeat: original.firstDownbeat,
    source: stillMatchesOriginal ? original.source : 'user',
  }
  downbeatText.value = original.firstDownbeat.toFixed(3)
}

/**
 * Mean distance from each onset to the grid point it would snap to, in milliseconds.
 * The honest feedback signal: adjust the tempo and watch it drop.
 */
const onsetErrorMs = computed(() => {
  const notes = props.notes
  if (notes.length === 0) return 0
  const step = (60 / grid.value.bpm) / grid.value.subdivision
  let total = 0
  for (const n of notes) {
    const snapped = grid.value.firstDownbeat + Math.round((n.start - grid.value.firstDownbeat) / step) * step
    total += Math.abs(n.start - snapped)
  }
  return (total / notes.length) * 1000
})

/**
 * A coarse read on how tightly the onsets sit on the grid, as a fraction of a *beat*.
 *
 * Deliberately not scaled to the subdivision step: a 16th-note grid has a step small enough that
 * ordinary performance microtiming eats most of it, so a step-relative score damns a perfectly
 * good grid the moment you ask for a finer one. Real transcribed onsets land tens of milliseconds
 * off however right the tempo is — a verified run against a real model sat at 41 ms while
 * engraving flawlessly to quarter notes.
 *
 * The wording is deliberately descriptive rather than a verdict, because this number genuinely
 * cannot tell a half-time grid from a correct one: halving the bpm yields a *subset* of the same
 * grid points, so the error is unchanged. The barline overlay and the notation are what catch
 * that; this only tells you whether the onsets cluster at all.
 */
const errorQuality = computed(() => {
  const beatMs = (60 / grid.value.bpm) * 1000
  const ratio = onsetErrorMs.value / beatMs
  if (ratio < 0.05) return { label: 'tight', cls: 'text-success' }
  if (ratio < 0.12) return { label: 'fair', cls: 'text-success' }
  return { label: 'loose', cls: 'text-warning' }
})
</script>

<template>
  <div class="flex flex-col gap-3 p-3 rounded-box bg-base-200" data-testid="tempo-editor">
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-semibold text-sm">Tempo &amp; bars</h3>
      <div class="text-xs" :class="errorQuality.cls" data-testid="onset-error">
        onset error {{ onsetErrorMs.toFixed(0) }} ms · {{ errorQuality.label }}
      </div>
    </div>

    <div class="flex flex-wrap items-end gap-2">
      <label class="form-control flex flex-col gap-1">
        <span class="label-text text-xs">BPM</span>
        <input
          :value="bpmText"
          type="number" step="0.1"
          class="input input-bordered input-sm w-24"
          data-testid="bpm-input"
          @focus="editingBpm = true"
          @input="onBpmInput(($event.target as HTMLInputElement).value)"
          @blur="onBpmBlur"
        >
      </label>

      <!-- ×2 and ÷2 alone fix the most common failure the beat tracker has. -->
      <div class="join">
        <button class="btn btn-sm join-item" data-testid="bpm-halve" @click="scaleBpm(0.5)">÷2</button>
        <button class="btn btn-sm join-item" @click="scaleBpm(1 / 1.5)">÷1.5</button>
        <button class="btn btn-sm join-item" @click="scaleBpm(1.5)">×1.5</button>
        <button class="btn btn-sm join-item" data-testid="bpm-double" @click="scaleBpm(2)">×2</button>
      </div>

      <label class="form-control flex flex-col gap-1">
        <span class="label-text text-xs">Beats per bar</span>
        <select
          :value="grid.beatsPerBar"
          class="select select-bordered select-sm w-20"
          data-testid="beats-per-bar"
          @change="setGrid({ beatsPerBar: Number(($event.target as HTMLSelectElement).value) })"
        >
          <option v-for="n in BEATS_PER_BAR_CHOICES" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>

      <label class="form-control flex flex-col gap-1">
        <span class="label-text text-xs">Finest note</span>
        <select
          :value="grid.subdivision"
          class="select select-bordered select-sm w-32"
          data-testid="subdivision"
          @change="setGrid({ subdivision: Number(($event.target as HTMLSelectElement).value) })"
        >
          <option v-for="s in SUBDIVISIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </label>

      <div class="form-control flex flex-col gap-1">
        <span class="label-text text-xs">First downbeat (s)</span>
        <div class="join">
          <input
            :value="downbeatText"
            type="number" step="0.001" min="0"
            class="input input-bordered input-sm w-24 join-item"
            data-testid="downbeat-input"
            @focus="editingDownbeat = true"
            @input="onDownbeatInput(($event.target as HTMLInputElement).value)"
            @blur="onDownbeatBlur"
          >
          <button
            class="btn btn-sm join-item"
            :class="pickingDownbeat ? 'btn-primary' : 'btn-outline'"
            data-testid="pick-downbeat"
            @click="emit('pickDownbeat')"
          >
            {{ pickingDownbeat ? 'Click the roll…' : 'Pick' }}
          </button>
          <button
            v-if="downbeatChanged"
            class="btn btn-sm btn-ghost join-item"
            data-testid="clear-downbeat"
            @click="clearDownbeat"
          >
            Clear
          </button>
        </div>
      </div>

      <div class="form-control flex flex-col gap-1">
        <span class="label-text text-xs">Grid</span>
        <button class="btn btn-sm btn-outline" data-testid="align-grid" @click="alignToNotes">
          Align to notes
        </button>
      </div>
    </div>

    <p class="text-xs text-base-content/60">
      <strong>Align to notes</strong> slides the grid onto the performance without changing which
      beat starts the bar — that is what lowers onset error. Clicking the roll moves the downbeat by
      whole beats, which is how you pick <em>which</em> beat begins the bar; a smaller move than
      that only slides the barlines between the notes and syncopates the whole piece.
      The barlines drawn over the piano roll are the real check: with the right tempo the note
      onsets line up with them, and with a half-time guess every other line lands in empty space.
      Onset error only says how tightly they cluster — it can't tell those two apart on its own.
      Too coarse a grid collapses fast passages; too fine brings the jitter back as unreadable
      notation.
    </p>
  </div>
</template>

<script setup lang="ts">
import { kgToLb, lbToKg, type WeightUnit } from '#shared/body'
import type { BiometricRow } from '~/composables/useDiary'
import { fromLocalDate } from '~/utils/dates'

const props = defineProps<{
  /** The day being logged for — used to date-stamp a fresh loss against
   *  `latestWeightDate` as "N days ago". */
  date: string
  /** The reading stored for this day, in kg. Null when nothing was logged. */
  weightKg: number | null
  unit: WeightUnit
  /** Every tracked measurement, with this day's value attached. */
  biometrics: BiometricRow[]
  /** Wording differs for past days: "Not logged" reads better than a prompt. */
  isToday: boolean
  /** Most recent weigh-in on any date, in kg, before this save — what a new
   *  reading is compared against to celebrate a loss. Null if never logged. */
  latestWeightKg: number | null
  /** The date that reading was logged on. Null exactly when latestWeightKg is. */
  latestWeightDate: string | null
}>()

const emit = defineEmits<{
  save: [weightKg: number]
  clear: []
  unit: [unit: WeightUnit]
  measure: [typeId: number, value: number | null]
  addType: [name: string, unit: string]
  removeType: [typeId: number]
}>()

// --- Weight ---------------------------------------------------------------

const editing = ref(false)
const draft = ref<number | null>(null)
const weightInput = useTemplateRef<HTMLInputElement>('weightInput')
/** The collapsed number-and-pencil row — where the new value lands once
 *  editing closes, and so where a loss should visually burst from. */
const weightDisplay = useTemplateRef<HTMLDivElement>('weightDisplay')

const { fireConfetti } = useConfetti()

/** Set only right after a save that came in under the last weigh-in; cleared
 *  on a timer so the toast doesn't outlive its moment. */
const lossToast = ref<{ kg: number; daysAgo: number | null } | null>(null)
let lossToastTimer: ReturnType<typeof setTimeout> | undefined

function daysBetween(laterIso: string, earlierIso: string): number {
  return Math.round((fromLocalDate(laterIso).getTime() - fromLocalDate(earlierIso).getTime()) / 86_400_000)
}

function celebrateLoss(lostKg: number, daysAgo: number | null) {
  const origin = weightDisplay.value?.getBoundingClientRect()
  fireConfetti(origin ? { x: origin.left + origin.width / 2, y: origin.top + origin.height / 2 } : undefined)

  lossToast.value = { kg: lostKg, daysAgo }
  clearTimeout(lossToastTimer)
  lossToastTimer = setTimeout(() => { lossToast.value = null }, 5000)
}

onBeforeUnmount(() => clearTimeout(lossToastTimer))

watch(editing, async (open) => {
  if (!open) return
  await nextTick()
  weightInput.value?.focus()
})

/** One decimal is the precision of a bathroom scale; more is false confidence. */
function inUnit(kg: number, unit: WeightUnit) {
  return Number((unit === 'lb' ? kgToLb(kg) : kg).toFixed(1))
}

const shown = computed(() =>
  props.weightKg === null ? null : inUnit(props.weightKg, props.unit),
)

/** Leaving edit mode when the day changes stops a draft following you to Tuesday. */
watch(
  () => [props.weightKg, props.isToday],
  () => {
    editing.value = false
  },
)

function startEdit() {
  draft.value = shown.value
  editing.value = true
}

/**
 * Switching unit converts what has already been typed rather than
 * reinterpreting it — 72 kg becomes 158.7 lb, not 72 lb.
 */
function switchUnit(next: WeightUnit) {
  if (next === props.unit) return
  if (draft.value !== null) {
    const kg = props.unit === 'lb' ? lbToKg(draft.value) : draft.value
    draft.value = inUnit(kg, next)
  }
  emit('unit', next)
}

/**
 * Compares the new reading against the most recent weigh-in on record — this
 * day's own previous value if it was the last one logged, otherwise whatever
 * came before. There's nothing to compare a first-ever reading against, so
 * that case just logs quietly.
 */
async function saveWeight() {
  if (draft.value === null || !Number.isFinite(draft.value)) return
  const kg = props.unit === 'lb' ? lbToKg(draft.value) : draft.value
  const rounded = Number(kg.toFixed(3))
  const previous = props.latestWeightKg

  emit('save', rounded)
  editing.value = false

  if (previous !== null && rounded < previous - 0.001) {
    // Days since whatever weigh-in `previous` came from — not shown when
    // that isn't a meaningful "ago" (today's own earlier reading, or, on a
    // past day being backfilled, a "latest" that's actually later than it).
    const gap = props.latestWeightDate ? daysBetween(props.date, props.latestWeightDate) : null
    const daysAgo = gap !== null && gap > 0 ? gap : null

    // Wait for the edit form to close and the number-and-pencil row to be
    // back in the DOM, so the burst centres on where the new figure lands
    // rather than on the input it replaced.
    await nextTick()
    celebrateLoss(previous - rounded, daysAgo)
  }
}

// --- Custom measurements --------------------------------------------------

/**
 * Values are edited in place: one tap on the number, type, blur. Custom
 * measurements are usually taken as a set (both biceps, waist, chest) so a
 * modal per reading would be four dialogs on a Sunday morning.
 */
const editingType = ref<number | null>(null)
const valueDraft = ref<number | null>(null)
// A plain (non-`useTemplateRef`) callback ref: inside `v-for`, Vue always
// collects a named template ref into an array, even though at most one row is
// ever in edit mode at a time — this stores just that one element instead.
let measureInputEl: HTMLInputElement | null = null
function setMeasureInputEl(el: Element | null) {
  measureInputEl = el as HTMLInputElement | null
}

function startMeasure(row: BiometricRow) {
  editingType.value = row.id
  valueDraft.value = row.value
}

watch(editingType, async (id) => {
  if (id === null) return
  await nextTick()
  measureInputEl?.focus()
})

function commitMeasure(row: BiometricRow) {
  if (editingType.value !== row.id) return
  const next = valueDraft.value
  editingType.value = null
  // Only round-trip when it actually changed.
  if ((next ?? null) === (row.value ?? null)) return
  emit('measure', row.id, next === null || !Number.isFinite(next) ? null : next)
}

const adding = ref(false)
const newName = ref('')
const newUnit = ref('cm')

const UNIT_CHOICES = ['cm', 'in', 'mm', '%', 'kg', 'lb', 'bpm']

function addType() {
  const name = newName.value.trim()
  if (!name) return
  emit('addType', name, newUnit.value)
  newName.value = ''
  adding.value = false
}

/** Two taps to remove, so a mis-tap doesn't take a year of measurements. */
const confirmingRemove = ref<number | null>(null)
</script>

<template>
  <section class="card bg-base-100 shadow-sm">
    <div class="card-body p-4 gap-3">
      <header class="flex items-center justify-between gap-2">
        <h2 class="font-semibold flex items-center gap-2">
          <AppIcon name="scale" class="w-4 h-4 text-secondary" />
          Body
        </h2>
      </header>

      <!-- Weight ---------------------------------------------------------->
      <div class="flex items-center justify-between gap-2 min-h-8">
        <span class="text-sm">Weight</span>

        <div v-if="!editing" ref="weightDisplay" class="flex items-center gap-1">
          <span v-if="shown !== null" class="text-sm tabular">
            {{ shown }} <span class="text-base-content/40">{{ unit }}</span>
          </span>
          <span v-else class="text-sm text-base-content/40">Not logged</span>
          <button
            class="btn btn-ghost btn-xs btn-square"
            :aria-label="shown === null ? 'Log weight' : 'Edit weight'"
            @click="startEdit"
          >
            <AppIcon :name="shown === null ? 'plus' : 'pencil'" class="w-4 h-4" />
          </button>
        </div>
      </div>

      <div v-if="editing" class="flex flex-col gap-2">
        <div class="join w-full">
          <input
            ref="weightInput"
            v-model.number="draft"
            type="number" min="10" step="any" inputmode="decimal"
            class="input input-bordered input-sm join-item flex-1"
            :placeholder="unit"
            aria-label="Weight"
            @keyup.enter="saveWeight"
          >
          <button
            v-for="u in (['kg', 'lb'] as WeightUnit[])"
            :key="u"
            class="btn btn-sm join-item"
            :class="unit === u ? 'btn-neutral' : 'btn-outline'"
            :aria-pressed="unit === u"
            @click="switchUnit(u)"
          >{{ u }}</button>
        </div>

        <div class="flex gap-2">
          <button
            class="btn btn-sm btn-primary flex-1"
            :disabled="draft === null"
            @click="saveWeight"
          >Save</button>
          <button class="btn btn-sm btn-ghost" @click="editing = false">Cancel</button>
          <button
            v-if="weightKg !== null"
            class="btn btn-sm btn-ghost btn-square text-error"
            aria-label="Remove weight"
            @click="emit('clear'); editing = false"
          >
            <AppIcon name="trash" class="w-4 h-4" />
          </button>
        </div>
      </div>

      <!-- Custom measurements --------------------------------------------->
      <div
        v-for="row in biometrics"
        :key="row.id"
        class="flex items-center justify-between gap-2 min-h-8 border-t border-base-200 pt-2"
      >
        <span class="text-sm flex-1 truncate">{{ row.name }}</span>

        <template v-if="editingType === row.id">
          <input
            :ref="setMeasureInputEl"
            v-model.number="valueDraft"
            type="number" step="any" inputmode="decimal"
            class="input input-bordered input-xs w-20 tabular"
            :aria-label="row.name"
            @keyup.enter="commitMeasure(row)"
            @blur="commitMeasure(row)"
          >
          <span class="text-xs text-base-content/40 w-8">{{ row.unit }}</span>
        </template>

        <template v-else>
          <button
            class="text-sm tabular px-2 py-0.5 rounded hover:bg-base-200"
            :aria-label="`Set ${row.name}`"
            @click="startMeasure(row)"
          >
            <template v-if="row.value !== null">
              {{ row.value }} <span class="text-base-content/40">{{ row.unit }}</span>
            </template>
            <span v-else class="text-base-content/40">— {{ row.unit }}</span>
          </button>

          <button
            v-if="confirmingRemove !== row.id"
            class="btn btn-ghost btn-xs btn-square"
            :aria-label="`Stop tracking ${row.name}`"
            @click="confirmingRemove = row.id"
          >
            <AppIcon name="x" class="w-3.5 h-3.5 opacity-40" />
          </button>
          <button
            v-else
            class="btn btn-error btn-xs"
            @click="emit('removeType', row.id); confirmingRemove = null"
          >Delete all?</button>
        </template>
      </div>

      <!-- Add a measurement ------------------------------------------------>
      <div v-if="adding" class="flex flex-col gap-2 border-t border-base-200 pt-2">
        <div class="join w-full">
          <input
            v-model="newName"
            type="text" maxlength="40"
            class="input input-bordered input-sm join-item flex-1"
            placeholder="Bicep, waist, resting HR…"
            aria-label="Measurement name"
            @keyup.enter="addType"
          >
          <select
            v-model="newUnit"
            class="select select-bordered select-sm join-item w-20"
            aria-label="Unit"
          >
            <option v-for="u in UNIT_CHOICES" :key="u" :value="u">{{ u }}</option>
          </select>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-sm btn-primary flex-1" :disabled="!newName.trim()" @click="addType">
            Track it
          </button>
          <button class="btn btn-sm btn-ghost" @click="adding = false">Cancel</button>
        </div>
      </div>

      <button
        v-else
        class="btn btn-ghost btn-xs self-start gap-1 text-base-content/60"
        @click="adding = true"
      >
        <AppIcon name="plus" class="w-3.5 h-3.5" />
        Add a measurement
      </button>

      <p v-if="!biometrics.length && !adding" class="text-xs text-base-content/50">
        Track anything else you measure — bicep, waist, resting heart rate.
      </p>
    </div>

    <div
      v-if="lossToast"
      class="toast toast-center sm:toast-end z-40 bottom-[calc(var(--dock-height)+env(safe-area-inset-bottom,0px)+0.75rem)] sm:bottom-4"
    >
      <div class="alert alert-success shadow-lg">
        <AppIcon name="scale" class="w-5 h-5" />
        <span>
          Down {{ inUnit(lossToast.kg, unit) }} {{ unit }} since your last weigh-in<template v-if="lossToast.daysAgo"> ({{ lossToast.daysAgo }} day{{ lossToast.daysAgo === 1 ? '' : 's' }} ago)</template>!
        </span>
      </div>
    </div>
  </section>
</template>

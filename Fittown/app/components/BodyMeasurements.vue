<script setup lang="ts">
import { kgToLb, lbToKg, type WeightUnit } from '#shared/body'
import type { BiometricRow } from '~/composables/useDiary'

const props = defineProps<{
  /** The reading stored for this day, in kg. Null when nothing was logged. */
  weightKg: number | null
  unit: WeightUnit
  /** Every tracked measurement, with this day's value attached. */
  biometrics: BiometricRow[]
  /** Wording differs for past days: "Not logged" reads better than a prompt. */
  isToday: boolean
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

function saveWeight() {
  if (draft.value === null || !Number.isFinite(draft.value)) return
  const kg = props.unit === 'lb' ? lbToKg(draft.value) : draft.value
  emit('save', Number(kg.toFixed(3)))
  editing.value = false
}

// --- Custom measurements --------------------------------------------------

/**
 * Values are edited in place: one tap on the number, type, blur. Custom
 * measurements are usually taken as a set (both biceps, waist, chest) so a
 * modal per reading would be four dialogs on a Sunday morning.
 */
const editingType = ref<number | null>(null)
const valueDraft = ref<number | null>(null)

function startMeasure(row: BiometricRow) {
  editingType.value = row.id
  valueDraft.value = row.value
}

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

        <div v-if="!editing" class="flex items-center gap-1">
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
            v-model.number="valueDraft"
            type="number" step="any" inputmode="decimal"
            class="input input-bordered input-xs w-20 tabular"
            :aria-label="row.name"
            autofocus
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
  </section>
</template>

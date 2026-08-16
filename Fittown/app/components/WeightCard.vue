<script setup lang="ts">
import { kgToLb, lbToKg, type WeightUnit } from '#shared/body'

const props = defineProps<{
  /** The reading stored for this day, in kg. Null when nothing was logged. */
  weightKg: number | null
  unit: WeightUnit
  /** Wording differs for past days: "Not logged" reads better than a prompt. */
  isToday: boolean
}>()

const emit = defineEmits<{
  save: [weightKg: number]
  clear: []
  unit: [unit: WeightUnit]
}>()

const editing = ref(false)
const draft = ref<number | null>(null)
const saving = ref(false)

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

async function save() {
  if (draft.value === null || !Number.isFinite(draft.value)) return
  const kg = props.unit === 'lb' ? lbToKg(draft.value) : draft.value
  saving.value = true
  try {
    emit('save', Number(kg.toFixed(3)))
    editing.value = false
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="card bg-base-100 shadow-sm">
    <div class="card-body p-4 gap-3">
      <header class="flex items-center justify-between gap-2">
        <h2 class="font-semibold flex items-center gap-2">
          <AppIcon name="scale" class="w-4 h-4 text-secondary" />
          Weight
        </h2>

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
      </header>

      <div v-if="editing" class="flex flex-col gap-2">
        <div class="join w-full">
          <input
            v-model.number="draft"
            type="number" min="10" step="any" inputmode="decimal"
            class="input input-bordered input-sm join-item flex-1"
            :placeholder="unit"
            aria-label="Weight"
            @keyup.enter="save"
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
            :disabled="draft === null || saving"
            @click="save"
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

      <p v-else-if="shown === null" class="text-xs text-base-content/50">
        {{ isToday ? 'Weigh in to track your trend over time.' : 'No weigh-in recorded for this day.' }}
      </p>
    </div>
  </section>
</template>

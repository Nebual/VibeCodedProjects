<script setup lang="ts">
import {
  BMI_CATEGORIES,
  bmiCategory,
  formatWeight,
  weightForBmi,
  type BmiCategory,
  type WeightUnit,
} from '#shared/body'

const props = defineProps<{
  open: boolean
  /** Null when height or weight is missing — the table still shows, minus the marker row. */
  value: number | null
  /** Null when not yet entered — the weight-range column shows a dash instead. */
  heightCm: number | null
  weightUnit: WeightUnit
}>()

const emit = defineEmits<{ close: [] }>()

const dialog = useTemplateRef<HTMLDialogElement>('dialog')

watch(
  () => props.open,
  (open) => {
    if (open) dialog.value?.showModal()
    else dialog.value?.close()
  },
)

const rounded = computed(() => (props.value === null ? null : Math.round(props.value * 10) / 10))
const category = computed(() => (props.value === null ? null : bmiCategory(props.value)))

/**
 * The weight, at the user's own height, that each category's boundaries work
 * out to — so "lose weight to reach a healthy BMI" becomes a concrete number
 * rather than something they have to work out themselves.
 */
function weightRange(c: BmiCategory): string {
  const heightCm = props.heightCm
  if (!heightCm) return '—'
  const fmt = (bmiBound: number) => formatWeight(weightForBmi(bmiBound, heightCm), props.weightUnit)
  if (c.min === null) return `below ${fmt(c.max!)}`
  if (c.max === null) return `${fmt(c.min)} and above`
  return `${fmt(c.min)} – ${fmt(c.max)}`
}
</script>

<template>
  <dialog ref="dialog" class="modal modal-bottom sm:modal-middle" @close="emit('close')">
    <div class="modal-box flex flex-col gap-3">
      <h3 class="font-semibold text-lg">Body mass index</h3>

      <div
        v-if="rounded !== null"
        class="rounded-box bg-base-200 p-3 flex items-center justify-between"
      >
        <div class="text-xs text-base-content/60">Your BMI</div>
        <div class="text-2xl font-semibold tabular">
          {{ rounded }}
          <span class="text-sm font-normal text-base-content/50">{{ category?.label }}</span>
        </div>
      </div>
      <p v-else class="text-xs text-base-content/50">
        Add your height and a weigh-in above to see where you sit on the scale.
      </p>

      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>Category</th>
              <th class="text-right">BMI range</th>
              <th class="text-right">Weight range</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in BMI_CATEGORIES"
              :key="c.key"
              :class="category?.key === c.key ? 'bg-primary/10 font-semibold' : ''"
            >
              <td>
                {{ c.label }}
                <AppIcon
                  v-if="category?.key === c.key"
                  name="check"
                  class="w-3.5 h-3.5 inline-block align-text-top ml-1 text-primary"
                />
              </td>
              <td class="text-right tabular">
                <template v-if="c.min === null">below {{ c.max }}</template>
                <template v-else-if="c.max === null">{{ c.min }} and above</template>
                <template v-else>{{ c.min }} – {{ c.max }}</template>
              </td>
              <td class="text-right tabular">{{ weightRange(c) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!heightCm" class="text-xs text-base-content/50">
        Add your height in About you to see the weight each category works out to.
      </p>

      <p class="text-[0.65rem] text-base-content/40 leading-snug">
        The WHO's standard adult bands — one formula for every body, so it reads
        muscle the same as fat. Someone heavily built or heavily trained can
        land in "overweight" with a low body-fat percentage. Useful as a
        starting signal, not a diagnosis.
      </p>

      <div class="modal-action mt-1">
        <button class="btn btn-primary" @click="emit('close')">Close</button>
      </div>
    </div>

    <form method="dialog" class="modal-backdrop">
      <button>close</button>
    </form>
  </dialog>
</template>

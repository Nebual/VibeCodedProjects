<script setup lang="ts">
import type { FoodRow, MealName } from '~/composables/useDiary'
import { MEAL_LABELS, MEAL_ORDER } from '~/composables/useDiary'

const props = defineProps<{
  open: boolean
  /** Meal this was opened from; still changeable before saving. */
  meal: MealName
  date: string
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const dialog = useTemplateRef<HTMLDialogElement>('dialog')

const mealChoice = ref<MealName>(props.meal)
const name = ref('')
const kcal = ref<number | null>(null)
const fat_g = ref<number | null>(null)
const carbs_g = ref<number | null>(null)
const protein_g = ref<number | null>(null)
const fiber_g = ref<number | null>(null)
const sugar_alcohols_g = ref<number | null>(null)

function reset() {
  mealChoice.value = props.meal
  name.value = ''
  kcal.value = null
  fat_g.value = null
  carbs_g.value = null
  protein_g.value = null
  fiber_g.value = null
  sugar_alcohols_g.value = null
  saveError.value = null
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      dialog.value?.close()
      return
    }
    reset()
    dialog.value?.showModal()
  },
)

/** Same "derive from macros" rule as creating a custom food — see food/new.vue. */
const derivedKcal = computed(() => {
  if (protein_g.value === null && carbs_g.value === null && fat_g.value === null) return null
  return Math.round((protein_g.value ?? 0) * 4 + (carbs_g.value ?? 0) * 4 + (fat_g.value ?? 0) * 9)
})

const effectiveKcal = computed(() => kcal.value ?? derivedKcal.value)

const macroFields = [
  { key: 'fat_g' as const, model: fat_g, label: 'Fat', unit: 'g' },
  { key: 'carbs_g' as const, model: carbs_g, label: 'Carbs', unit: 'g' },
  { key: 'protein_g' as const, model: protein_g, label: 'Protein', unit: 'g' },
  { key: 'fiber_g' as const, model: fiber_g, label: 'Fibre', unit: 'g' },
  { key: 'sugar_alcohols_g' as const, model: sugar_alcohols_g, label: 'Sugar alcohols', unit: 'g' },
]

const valid = computed(() => effectiveKcal.value !== null && effectiveKcal.value > 0)

const saving = ref(false)
const saveError = ref<string | null>(null)

async function save() {
  if (!valid.value) return
  saving.value = true
  saveError.value = null
  try {
    const { food } = await $fetch<{ food: FoodRow }>('/api/foods', {
      method: 'POST',
      body: {
        name: name.value.trim() || 'Quick add',
        basis_grams: 100,
        kcal: kcal.value,
        fat_g: fat_g.value,
        carbs_g: carbs_g.value,
        protein_g: protein_g.value,
        fiber_g: fiber_g.value,
        sugar_alcohols_g: sugar_alcohols_g.value,
      },
    })
    await $fetch('/api/diary/entries', {
      method: 'POST',
      body: { date: props.date, meal: mealChoice.value, food_id: food.id, grams: 100 },
    })
    emit('saved')
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <dialog ref="dialog" class="modal modal-bottom sm:modal-middle" @close="emit('close')">
    <div class="modal-box flex flex-col gap-3">
      <h3 class="font-semibold text-lg">Quick add</h3>

      <label class="form-control">
        <span class="label-text text-xs mb-1">Meal</span>
        <div role="tablist" class="tabs tabs-box">
          <button
            v-for="m in MEAL_ORDER"
            :key="m"
            role="tab"
            class="tab flex-1 text-xs"
            :class="{ 'tab-active': mealChoice === m }"
            @click="mealChoice = m"
          >
            {{ MEAL_LABELS[m] }}
          </button>
        </div>
      </label>

      <label class="form-control">
        <span class="label-text text-xs mb-1">Name <span class="opacity-50">optional</span></span>
        <input
          v-model="name"
          type="text"
          class="input input-bordered"
          placeholder="Quick add"
        >
      </label>

      <label class="form-control">
        <span class="label-text text-xs mb-1">
          Calories (kcal)
          <span v-if="kcal === null && derivedKcal !== null" class="opacity-60">
            — will use {{ derivedKcal }} from macros
          </span>
        </span>
        <input
          v-model.number="kcal"
          type="number" min="0" step="any" inputmode="decimal"
          class="input input-bordered"
          :placeholder="derivedKcal !== null ? String(derivedKcal) : ''"
        >
      </label>

      <div class="grid grid-cols-2 gap-2">
        <label v-for="f in macroFields" :key="f.key" class="form-control">
          <span class="label-text text-xs mb-1">{{ f.label }} ({{ f.unit }})</span>
          <input
            v-model.number="f.model.value"
            type="number" min="0" step="any" inputmode="decimal"
            class="input input-bordered input-sm w-full"
          >
        </label>
      </div>

      <div v-if="saveError" class="alert alert-error text-sm py-2">{{ saveError }}</div>

      <div class="modal-action mt-1">
        <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary gap-2" :disabled="!valid || saving" @click="save">
          <span v-if="saving" class="loading loading-spinner loading-sm" />
          Add
        </button>
      </div>
    </div>

    <form method="dialog" class="modal-backdrop">
      <button>close</button>
    </form>
  </dialog>
</template>

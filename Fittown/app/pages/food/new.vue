<script setup lang="ts">
import type { FoodRow, MealName } from '~/composables/useDiary'

useHead({ title: 'New food · Fittown' })

const route = useRoute()
const router = useRouter()
const meal = computed(() => (route.query.meal as MealName) || 'snack')
const today = useToday()
const date = computed(() => (route.query.d as string) || today.value)
/** Set when this food is being invented to go into a recipe. */
const recipeId = computed(() => (route.query.recipe ? Number(route.query.recipe) : null))

const form = reactive({
  name: '',
  brand: '',
  barcode: (route.query.barcode as string) || '',
  is_liquid: false,
  /** What the entered numbers describe — a serving, or a flat 100 g. */
  basis: 'serving' as 'serving' | 'hundred',
  basis_grams: 100,
  kcal: null as number | null,
  protein_g: null as number | null,
  carbs_g: null as number | null,
  fat_g: null as number | null,
  fiber_g: null as number | null,
  sugars_g: null as number | null,
  sat_fat_g: null as number | null,
  sodium_mg: null as number | null,
})

const unit = computed(() => (form.is_liquid ? 'ml' : 'g'))

// "Per 100 g" is just a fixed basis; keep the two in sync so the payload is
// always expressed the same way server-side.
watch(
  () => form.basis,
  (basis) => {
    if (basis === 'hundred') form.basis_grams = 100
  },
)

const derivedKcal = computed(() => {
  const { protein_g: p, carbs_g: c, fat_g: f } = form
  if (p === null && c === null && f === null) return null
  return Math.round((p ?? 0) * 4 + (c ?? 0) * 4 + (f ?? 0) * 9)
})

const saving = ref(false)
const error = ref<string | null>(null)

const valid = computed(
  () => form.name.trim().length >= 2 && form.basis_grams > 0
    && (form.kcal !== null || derivedKcal.value !== null),
)

async function save() {
  if (!valid.value) return
  saving.value = true
  error.value = null

  try {
    const { food } = await $fetch<{ food: FoodRow }>('/api/foods', {
      method: 'POST',
      body: {
        ...form,
        // A serving basis doubles as the food's default serving size.
        serving_grams: form.basis === 'serving' ? form.basis_grams : null,
        serving_size_text: form.basis === 'serving' ? `${form.basis_grams} ${unit.value}` : null,
      },
    })
    // Straight to the portion screen so they can log it — or drop it into the
    // recipe they were building when they realised the food didn't exist yet.
    await router.replace(
      `/food/${food.id}?${foodLinkQuery({
        meal: meal.value,
        date: date.value,
        recipe: recipeId.value,
      })}`,
    )
  } catch (err) {
    error.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save this food'
    saving.value = false
  }
}

const macroFields = [
  { key: 'protein_g', label: 'Protein', unit: 'g' },
  { key: 'carbs_g', label: 'Carbs', unit: 'g' },
  { key: 'fat_g', label: 'Fat', unit: 'g' },
  { key: 'fiber_g', label: 'Fibre', unit: 'g' },
  { key: 'sugars_g', label: 'Sugars', unit: 'g' },
  { key: 'sat_fat_g', label: 'Saturated fat', unit: 'g' },
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg' },
] as const
</script>

<template>
  <div class="flex flex-col gap-3">
    <header class="flex items-center gap-2">
      <button class="btn btn-ghost btn-sm btn-square" aria-label="Back" @click="router.back()">
        <AppIcon name="chevronLeft" class="w-5 h-5" />
      </button>
      <h1 class="font-semibold flex-1">New food</h1>
    </header>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <label class="form-control">
          <span class="label-text text-xs mb-1">Name</span>
          <input v-model="form.name" type="text" class="input input-bordered" placeholder="Porridge oats">
        </label>

        <div class="flex gap-2">
          <label class="form-control flex-1">
            <span class="label-text text-xs mb-1">Brand <span class="opacity-50">optional</span></span>
            <input v-model="form.brand" type="text" class="input input-bordered w-full">
          </label>
          <label class="form-control flex-1">
            <span class="label-text text-xs mb-1">Barcode <span class="opacity-50">optional</span></span>
            <input v-model="form.barcode" type="text" inputmode="numeric" class="input input-bordered w-full">
          </label>
        </div>

        <label class="label cursor-pointer justify-start gap-3">
          <input v-model="form.is_liquid" type="checkbox" class="toggle toggle-sm">
          <span class="label-text">Measured in millilitres</span>
        </label>
      </div>
    </section>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold">Nutrition</h2>

        <div role="tablist" class="tabs tabs-box">
          <button
            role="tab" class="tab flex-1"
            :class="{ 'tab-active': form.basis === 'serving' }"
            @click="form.basis = 'serving'"
          >Per serving</button>
          <button
            role="tab" class="tab flex-1"
            :class="{ 'tab-active': form.basis === 'hundred' }"
            @click="form.basis = 'hundred'"
          >Per 100 {{ unit }}</button>
        </div>

        <label v-if="form.basis === 'serving'" class="form-control">
          <span class="label-text text-xs mb-1">Serving size ({{ unit }})</span>
          <input
            v-model.number="form.basis_grams"
            type="number" min="0" step="any" inputmode="decimal"
            class="input input-bordered"
          >
        </label>

        <label class="form-control">
          <span class="label-text text-xs mb-1">
            Calories (kcal)
            <span v-if="form.kcal === null && derivedKcal !== null" class="opacity-60">
              — will use {{ derivedKcal }} from macros
            </span>
          </span>
          <input
            v-model.number="form.kcal"
            type="number" min="0" step="any" inputmode="decimal"
            class="input input-bordered"
            :placeholder="derivedKcal !== null ? String(derivedKcal) : ''"
          >
        </label>

        <div class="grid grid-cols-2 gap-2">
          <label v-for="f in macroFields" :key="f.key" class="form-control">
            <span class="label-text text-xs mb-1">{{ f.label }} ({{ f.unit }})</span>
            <input
              v-model.number="form[f.key]"
              type="number" min="0" step="any" inputmode="decimal"
              class="input input-bordered input-sm w-full"
            >
          </label>
        </div>

        <p class="text-xs text-base-content/50">
          Values are for {{ form.basis === 'serving' ? `one ${form.basis_grams} ${unit} serving` : `100 ${unit}` }}.
        </p>
      </div>
    </section>

    <div v-if="error" class="alert alert-error text-sm">{{ error }}</div>

    <button class="btn btn-primary gap-2" :disabled="!valid || saving" @click="save">
      <span v-if="saving" class="loading loading-spinner loading-sm" />
      Save and choose portion
    </button>
  </div>
</template>

<script setup lang="ts">
import { NUTRIENT_BY_KEY } from '#shared/nutrients'
import type { FoodRow, MealName } from '~/composables/useDiary'

useHead({ title: 'New food · Fittown' })

/** Shape of POST /api/foods/label — serving info plus recognised nutrient amounts. */
interface LabelScanResult {
  serving: { label: string | null; grams: number | null }
  nutrients: Record<string, number>
}

const route = useRoute()
const router = useRouter()
const meal = computed(() => (route.query.meal as MealName) || 'snack')
// Logging food after midnight belongs on yesterday's page — same late-night
// rule as the diary itself.
const diaryDay = useDiaryDay()
const date = computed(() => (route.query.d as string) || diaryDay.value)
/** Set when this food is being invented to go into a recipe. */
const recipeId = computed(() => (route.query.recipe ? Number(route.query.recipe) : null))

const form = reactive({
  name: '',
  brand: '',
  barcode: (route.query.barcode as string) || '',
  is_liquid: false,
  /** What the entered numbers describe — a serving, or a flat 100 g. */
  basis: 'serving' as 'serving' | 'hundred',
  basis_grams: 100 as number | null,
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

// --- scanning a Nutrition Facts label to prefill the form ----------------
// Same on/off as the recipe photo scanner: the label scan talks to the same
// local vision model, so there's nothing to set up twice.
const { public: publicConfig } = useRuntimeConfig()
const labelScanEnabled = computed(() => Boolean(publicConfig.recipeOcrEnabled))
const scanning = ref(false)
const scanError = ref<string | null>(null)
const scanNotice = ref<string | null>(null)
const labelFileInput = ref<HTMLInputElement | null>(null)

/** Nutrient keys the base form already has an input for; the rest land in `extraNutrients`. */
const BASE_NUTRIENT_KEYS = new Set([
  'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugars_g', 'sat_fat_g', 'sodium_mg',
])
/**
 * Nutrient amounts a label mentioned that the form doesn't normally show
 * (e.g. Calcium, Iron, Potassium, Cholesterol). They're rendered as inputs
 * only after a scan finds them, and saved through the ordinary foods route.
 */
const extraNutrients = reactive<Record<string, number | null>>({})

/** Plenty for the model to read label text from, and a fraction of a raw phone photo's size. */
const MAX_LABEL_DIMENSION = 1600

async function onLabelPhotoSelected(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  scanError.value = null
  try {
    const image = await resizeImageToJpeg(file, MAX_LABEL_DIMENSION)
    scanning.value = true
    const result = await $fetch<LabelScanResult>('/api/foods/label', {
      method: 'POST',
      body: { image },
    })
    applyLabelScan(result)
    scanNotice.value = result.serving.grams
      ? `Filled from the label — per ${result.serving.label ?? `${result.serving.grams} g`}.`
      : 'Filled from the label.'
  } catch (err) {
    scanError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not read that label'
  } finally {
    scanning.value = false
    if (labelFileInput.value) labelFileInput.value.value = ''
  }
}

function applyLabelScan(result: LabelScanResult) {
  if (result.serving.grams && result.serving.grams >= 0.1) {
    form.basis = 'serving'
    form.basis_grams = result.serving.grams
  } else {
    // No usable serving weight: the label's amounts are per 100 g/ml.
    form.basis = 'hundred'
  }
  for (const [key, value] of Object.entries(result.nutrients)) {
    if (BASE_NUTRIENT_KEYS.has(key)) {
      ;(form as Record<string, unknown>)[key] = value
    } else {
      extraNutrients[key] = value
    }
  }
}

function nutrientLabel(key: string) {
  return NUTRIENT_BY_KEY.get(key)?.label ?? key
}

function nutrientUnit(key: string) {
  return NUTRIENT_BY_KEY.get(key)?.unit ?? ''
}

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

// --- scanning a barcode to fill the field ----------------------------------
const showScanner = ref(false)
/** The existing food this barcode already belongs to, if any (info, not a block). */
const existingMatch = ref<FoodRow | null>(null)

function onScanned(code: string) {
  form.barcode = code
  showScanner.value = false
  checkExisting(code)
}

const checkTimer = ref<ReturnType<typeof setTimeout> | null>(null)

/** "Does any food I can see already use this barcode?" — shown as an info note. */
async function checkExisting(code: string) {
  existingMatch.value = null
  if (!code || code.length < 6) return
  try {
    const { food } = await $fetch<{ food: FoodRow }>(`/api/foods/barcode/${encodeURIComponent(code)}`)
    existingMatch.value = food
  } catch {
    existingMatch.value = null
  }
}

// Re-check as they type/paste, but not on every keystroke.
watch(
  () => form.barcode,
  (code) => {
    if (checkTimer.value) clearTimeout(checkTimer.value)
    if (!code || code.length < 6) {
      existingMatch.value = null
      return
    }
    checkTimer.value = setTimeout(() => {
      checkExisting(code)
      checkTimer.value = null
    }, 400)
  },
)

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
        // Nutrients picked up from a scanned label that the base form doesn't
        // always show (Calcium, Iron, …) ride along; the route reads every
        // NUTRIENT_KEYS column.
        ...extraNutrients,
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
  { key: 'fat_g', label: 'Fat', unit: 'g' },
  { key: 'carbs_g', label: 'Carbs', unit: 'g' },
  { key: 'protein_g', label: 'Protein', unit: 'g' },
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
        <div v-if="labelScanEnabled">
          <input
            ref="labelFileInput"
            type="file"
            accept="image/*"
            capture="environment"
            class="hidden"
            @change="onLabelPhotoSelected"
          >
          <button
            type="button"
            class="btn btn-outline gap-2 w-full"
            :disabled="scanning"
            @click="labelFileInput?.click()"
          >
            <span v-if="scanning" class="loading loading-spinner loading-sm" />
            <AppIcon v-else name="camera" class="w-4 h-4" />
            {{ scanning ? 'Reading the label…' : 'Scan a Nutrition Facts label' }}
          </button>
          <p v-if="scanError" class="text-xs text-error mt-2">{{ scanError }}</p>
          <p v-if="scanNotice" class="text-xs text-success mt-2">{{ scanNotice }}</p>
        </div>

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
            <span class="label-text text-xs mb-1">
              Barcode <span class="opacity-50">optional</span>
              <button
                type="button"
                class="btn btn-ghost btn-xs btn-square align-middle"
                aria-label="Scan barcode"
                @click="showScanner = true"
              >
                <AppIcon name="barcode" class="w-4 h-4" />
              </button>
            </span>
            <input v-model="form.barcode" type="text" inputmode="numeric" class="input input-bordered w-full">
          </label>
        </div>

        <div v-if="existingMatch" class="alert alert-info text-sm">
          <span class="flex-1">
            This barcode already belongs to
            <NuxtLink
              :to="`/food/${existingMatch.id}`"
              target="_blank"
              rel="noopener"
              class="link"
            >{{ existingMatch.brand ? `${existingMatch.brand} ${existingMatch.name}` : existingMatch.name }}</NuxtLink>.
            You can still create your own.
          </span>
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
          <MathNumberInput
            v-model="form.basis_grams"
            class="input input-bordered"
            wrapper-class="w-full"
          />
        </label>

        <label class="form-control">
          <span class="label-text text-xs mb-1">
            Calories (kcal)
            <span v-if="form.kcal === null && derivedKcal !== null" class="opacity-60">
              — will use {{ derivedKcal }} from macros
            </span>
          </span>
          <MathNumberInput
            v-model="form.kcal"
            class="input input-bordered"
            wrapper-class="w-full"
            :placeholder="derivedKcal !== null ? String(derivedKcal) : ''"
          />
        </label>

        <div class="grid grid-cols-2 gap-2">
          <label v-for="f in macroFields" :key="f.key" class="form-control">
            <span class="label-text text-xs mb-1">{{ f.label }} ({{ f.unit }})</span>
            <MathNumberInput
              v-model="form[f.key]"
              class="input input-bordered input-sm w-full"
              wrapper-class="w-full"
            />
          </label>
        </div>

        <!-- Extra nutrients a scanned label mentioned (Calcium, Iron, …). Shown
             only once a scan finds one; editable like any other field. -->
        <template v-if="Object.keys(extraNutrients).length">
          <div class="divider my-0 text-xs opacity-50">Also on the label</div>
          <div class="grid grid-cols-2 gap-2">
            <label
              v-for="key in Object.keys(extraNutrients)"
              :key="key"
              class="form-control"
            >
              <span class="label-text text-xs mb-1">{{ nutrientLabel(key) }} ({{ nutrientUnit(key) }})</span>
              <MathNumberInput
                v-model="extraNutrients[key]"
                class="input input-bordered input-sm w-full"
                wrapper-class="w-full"
              />
            </label>
          </div>
        </template>

        <p class="text-xs text-base-content/50">
          Values are for {{ form.basis === 'serving' ? `one ${form.basis_grams ?? '…'} ${unit} serving` : `100 ${unit}` }}.
        </p>
      </div>
    </section>

    <div v-if="error" class="alert alert-error text-sm">{{ error }}</div>

    <button class="btn btn-primary gap-2" :disabled="!valid || saving" @click="save">
      <span v-if="saving" class="loading loading-spinner loading-sm" />
      Save and choose portion
    </button>
  </div>

  <BarcodeScanner
    v-if="showScanner"
    :meal="meal"
    :date="date"
    capture
    @scanned="onScanned"
    @close="showScanner = false"
  />
</template>

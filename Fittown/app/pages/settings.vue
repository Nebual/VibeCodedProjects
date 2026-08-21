<script setup lang="ts">
import type { Goals } from '~/composables/useDiary'
import {
  ACTIVITY_LEVELS,
  DEFAULT_CALORIE_GOAL,
  activityLevel,
  bmi,
  cmToFtIn,
  formatWeight,
  ftInToCm,
  kgToLb,
  lbToKg,
  type HeightUnit,
  type Sex,
  type WeightUnit,
} from '#shared/body'
import type { MeasurementSystem } from '#shared/portions'
import { SHARE_TOGGLES, sharePermissions, type ShareKey } from '#shared/sharing'

useHead({ title: 'Settings · Fittown' })

const { user, clear } = useUserSession()
const { data, refresh } = await useFetch<{
  goals: Goals
  latest_weight: { date: string; weight_kg: number } | null
}>('/api/goals')

const form = reactive<Partial<Goals>>({})

/**
 * Seed the form from the server once, then only after an explicit save.
 *
 * A blanket `watchEffect` also fires on the refresh that follows logging a
 * weight, which silently threw away anything typed but not yet saved — fill in
 * your height, log your weight, and the height reverted.
 */
const seeded = ref(false)
watchEffect(() => {
  if (seeded.value || !data.value?.goals) return
  Object.assign(form, data.value.goals)
  seeded.value = true
})

const saved = ref(false)
const saving = ref(false)

/**
 * Macro grams imply a calorie total. Showing the gap lets people notice that
 * their macro split doesn't add up to the goal they set.
 */
const macroCalories = computed(() =>
  Math.round((form.protein_g ?? 0) * 4 + (form.carbs_g ?? 0) * 4 + (form.fat_g ?? 0) * 9),
)
const macroGap = computed(() => macroCalories.value - (form.calorie_goal ?? 0))

/**
 * Macros are stored as grams, but people think in percentages — "40% carbs"
 * is a plan, "225 g of carbs" is a consequence of one. Both are editable and
 * kept in sync: the percentage is of the *calorie goal*, so three figures that
 * add to 100% are exactly a split that uses the whole budget.
 */
const MACROS = [
  { key: 'fat_g', label: 'Fat', kcalPerGram: 9, defaultPercent: 30 },
  { key: 'carbs_g', label: 'Carbs', kcalPerGram: 4, defaultPercent: 50 },
  { key: 'protein_g', label: 'Protein', kcalPerGram: 4, defaultPercent: 20 },
] as const

type MacroKey = (typeof MACROS)[number]['key']

function macroPercent(macro: (typeof MACROS)[number]): number {
  const goal = form.calorie_goal ?? 0
  if (!goal) return 0
  return Math.round((((form[macro.key] ?? 0) * macro.kcalPerGram) / goal) * 100)
}

function setMacroPercent(macro: (typeof MACROS)[number], percent: number | null) {
  const goal = form.calorie_goal ?? 0
  if (!goal || percent === null || !Number.isFinite(percent)) return
  form[macro.key] = Math.round((goal * (percent / 100)) / macro.kcalPerGram)
}

const splitTotal = computed(() =>
  MACROS.reduce((sum, macro) => sum + macroPercent(macro), 0),
)

/** 20 / 50 / 30 — a balanced split that suits most people most of the time. */
function applyDefaultSplit() {
  for (const macro of MACROS) setMacroPercent(macro, macro.defaultPercent)
}

/**
 * "20 / 50 / 30", read off MACROS rather than written out.
 *
 * It was a hardcoded string, and when the defaults moved it kept advertising the
 * old split while the button applied the new one.
 */
const defaultSplitLabel = MACROS.map((macro) => macro.defaultPercent).join(' / ')

async function save() {
  saving.value = true
  saved.value = false
  try {
    await $fetch('/api/goals', { method: 'PUT', body: { ...form } })
    await refresh()
    // Safe here, unlike in the seeding watcher: this is what was just stored.
    if (data.value?.goals) Object.assign(form, data.value.goals)
    saved.value = true
    setTimeout(() => (saved.value = false), 2500)
  } finally {
    saving.value = false
  }
}

const today = useToday()

// --- Sharing --------------------------------------------------------------

/**
 * The five switches save the moment they're flipped, unlike the rest of this
 * screen.
 *
 * A privacy control that needs a separate "Save settings" press is a control
 * people believe they have already used. `form` is updated too, so the big
 * save button later on doesn't send back the value they just turned off.
 */
const sharingBusy = ref<string | null>(null)

/** Reads straight off the form, so a toggle reflects its own optimistic flip. */
const sharing = computed(() => sharePermissions(form))

async function setSharing(key: ShareKey, value: boolean) {
  sharingBusy.value = key
  const previous = form[key]
  form[key] = value ? 1 : 0
  try {
    await $fetch('/api/goals', { method: 'PUT', body: { [key]: value } })
  } catch {
    form[key] = previous
  } finally {
    sharingBusy.value = null
  }
}

// --- About you ------------------------------------------------------------

/**
 * Age is entered in years but stored as a birth year, so it stays right next
 * year instead of quietly going stale. Derived from the user's own calendar
 * day rather than the server's — the two disagree for a few hours every day.
 */
const currentYear = computed(() =>
  today.value ? Number(today.value.slice(0, 4)) : null,
)

/**
 * Held as its own ref rather than a computed over `birth_year`, because
 * `currentYear` is null until the browser's timezone resolves — a computed
 * setter would have to drop anything typed in that window on the floor.
 */
const age = ref<number | null>(null)

watch(
  [currentYear, () => form.birth_year],
  ([year, birthYear]) => {
    if (year && birthYear && age.value === null) age.value = year - birthYear
  },
  { immediate: true },
)

watch([age, currentYear], ([years, year]) => {
  if (!year) return
  form.birth_year =
    years === null || !Number.isFinite(years) ? null : year - years
})

const SEXES: { value: Sex; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'unspecified', label: 'Prefer not to say' },
]

/** Height entry in whichever unit is selected; always stored as cm. */
const heightUnit = computed<HeightUnit>({
  get: () => form.height_unit ?? 'cm',
  set: (unit) => (form.height_unit = unit),
})

const feet = computed<number | null>({
  get: () => (form.height_cm ? cmToFtIn(form.height_cm).ft : null),
  set: (value) => {
    const inches = form.height_cm ? cmToFtIn(form.height_cm).in : 0
    form.height_cm = value === null ? null : ftInToCm(value, inches)
  },
})

const inches = computed<number | null>({
  get: () => (form.height_cm ? cmToFtIn(form.height_cm).in : null),
  set: (value) => {
    const ft = form.height_cm ? cmToFtIn(form.height_cm).ft : 0
    form.height_cm = value === null ? null : ftInToCm(ft, value)
  },
})

const selectedActivity = computed(() => activityLevel(form.activity_level))

/** Null until both height and a weight (typed or last logged) are known. */
const bmiValue = computed(() => {
  if (!form.height_cm || currentWeightKg.value === null) return null
  return bmi(currentWeightKg.value, form.height_cm)
})

const bmiOpen = ref(false)

/**
 * Activity multipliers already include the exercise a typical week contains.
 * Logging that same exercise a second time — especially with "add exercise
 * calories" on — inflates the budget twice for one workout.
 */
const activityIncludesExercise = computed(
  () => !!form.activity_level && form.activity_level !== 'sedentary',
)

// --- Weight ---------------------------------------------------------------

const weightUnit = computed<WeightUnit>({
  get: () => form.weight_unit ?? 'kg',
  set: (unit) => {
    // Convert what's already typed rather than reinterpreting the number.
    if (weightDraft.value !== null) {
      const kg = weightUnit.value === 'lb' ? lbToKg(weightDraft.value) : weightDraft.value
      weightDraft.value = Number((unit === 'lb' ? kgToLb(kg) : kg).toFixed(1))
    }
    form.weight_unit = unit
  },
})

const weightDraft = ref<number | null>(null)
const weightSaved = ref(false)

/** Seed the field with the most recent weigh-in so it's an edit, not a re-entry. */
watchEffect(() => {
  const latest = data.value?.latest_weight
  if (latest && weightDraft.value === null) {
    weightDraft.value = Number(
      (weightUnit.value === 'lb' ? kgToLb(latest.weight_kg) : latest.weight_kg).toFixed(1),
    )
  }
})

/** Current weight in kg — the calculator's input, from the field or the last weigh-in. */
const currentWeightKg = computed(() => {
  if (weightDraft.value !== null && Number.isFinite(weightDraft.value)) {
    return weightUnit.value === 'lb' ? lbToKg(weightDraft.value) : weightDraft.value
  }
  return data.value?.latest_weight?.weight_kg ?? null
})

async function saveWeight() {
  if (weightDraft.value === null || !today.value) return
  const kg = weightUnit.value === 'lb' ? lbToKg(weightDraft.value) : weightDraft.value
  await $fetch('/api/weight', {
    method: 'POST',
    body: { date: today.value, weight_kg: Number(kg.toFixed(3)) },
  })
  await refresh()
  weightSaved.value = true
  setTimeout(() => (weightSaved.value = false), 2500)
}

// --- Unit systems ---------------------------------------------------------

const BODY_SYSTEMS = [
  { value: 'metric' as const, label: 'Metric (cm, kg)' },
  { value: 'imperial' as const, label: 'Imperial (ft, lb)' },
]

const FOOD_SYSTEMS = [
  { value: 'metric' as const, label: 'Metric (g, ml)' },
  { value: 'imperial' as const, label: 'Imperial (oz, fl oz)' },
]

/**
 * The grouped control sets height and weight together, but the per-field
 * toggles above can leave them disagreeing — cm with lb is a perfectly
 * reasonable combination — so "mixed" is a state this has to be able to show
 * rather than quietly overwrite.
 */
const bodySystem = computed<MeasurementSystem | 'mixed'>({
  get: () => {
    if (heightUnit.value === 'cm' && weightUnit.value === 'kg') return 'metric'
    if (heightUnit.value === 'ftin' && weightUnit.value === 'lb') return 'imperial'
    return 'mixed'
  },
  set: (system) => {
    if (system === 'mixed') return
    heightUnit.value = system === 'metric' ? 'cm' : 'ftin'
    // Through the computed, so anything typed in the weight box is converted
    // rather than reinterpreted.
    weightUnit.value = system === 'metric' ? 'kg' : 'lb'
  },
})

/** Water is a food measurement, so it follows the same switch. */
const foodSystem = computed<MeasurementSystem>({
  get: () => form.food_system ?? 'metric',
  set: (system) => {
    form.food_system = system
    form.volume_unit = system === 'metric' ? 'ml' : 'floz'
  },
})

// --- Calorie target -------------------------------------------------------

const calculatorOpen = ref(false)

/** Everything the equation needs. Missing pieces are named in the UI. */
const missingForCalculator = computed(() => {
  const missing: string[] = []
  if (!form.birth_year) missing.push('age')
  if (!form.sex) missing.push('gender')
  if (!form.height_cm) missing.push('height')
  if (currentWeightKg.value === null) missing.push('weight')
  if (!form.activity_level) missing.push('activity level')
  return missing
})

async function applyPlan(plan: {
  calorie_goal: number
  goal_weight_kg: number | null
  goal_rate_kg_per_week: number
  macros?: { protein_g: number; carbs_g: number; fat_g: number }
  water_goal_ml?: number
}) {
  // A sugar limit that tracked one of the % presets follows the calorie goal:
  // lowering the target should drop the sugar budget with it (e.g. 2000 kcal →
  // 50 g is 10%, so 1800 kcal becomes 45 g). A limit set by hand in grams — one
  // that matches no preset — is the user's own number and is left alone.
  const oldCalories = form.calorie_goal ?? 0
  const oldSugar = form.sugar_limit_g
  const sugarPercent = sugarPercentOf(oldCalories, oldSugar)
  form.calorie_goal = plan.calorie_goal
  form.goal_weight_kg = plan.goal_weight_kg
  form.goal_rate_kg_per_week = plan.goal_rate_kg_per_week
  if (sugarPercent !== null && plan.calorie_goal !== oldCalories) {
    setSugarPercent(sugarPercent)
  }
  if (plan.macros) Object.assign(form, plan.macros)
  if (plan.water_goal_ml !== undefined) form.water_goal_ml = plan.water_goal_ml
  calculatorOpen.value = false
  await save()
}

/**
 * Primary rather than outline when the calorie goal is still whatever a new
 * account starts with — a nudge to actually run the numbers, that backs off
 * once someone has set a real target of their own (even one that happens to
 * equal the default).
 */
const calorieGoalIsDefault = computed(() => form.calorie_goal === DEFAULT_CALORIE_GOAL)

async function clearPlan() {
  form.goal_weight_kg = null
  form.goal_rate_kg_per_week = null
  await save()
}

/** "Losing 0.5 kg a week toward 75 kg" — the stored plan, in words. */
const planSummary = computed(() => {
  const rate = form.goal_rate_kg_per_week
  if (rate === null || rate === undefined) return null
  const unit = weightUnit.value
  const perWeek = Math.abs(unit === 'lb' ? kgToLb(rate) : rate).toFixed(2).replace(/0$/, '')
  const verb = rate === 0 ? 'Maintaining' : rate < 0 ? 'Losing' : 'Gaining'
  const pace = rate === 0 ? 'your current weight' : `${perWeek} ${unit} a week`
  const towards =
    form.goal_weight_kg != null
      ? ` towards ${formatWeight(form.goal_weight_kg, unit)}`
      : ''
  return `${verb} ${pace}${towards}.`
})

/**
 * The diamond-ring poll at the bottom of the page. Both buttons set this, so
 * the answer is always "Yes" — that's the joke. Local state only: it isn't
 * sent anywhere, isn't stored, and resets on reload.
 */
const pollVoted = ref(false)

async function signOut() {
  await $fetch('/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}

/**
 * The *added sugar* goal is an upper limit ("stay under"), set as a percentage
 * of calorie intake — the FDA's 10% DV figure, with 5% as the stricter option.
 * Sugar is ~4 kcal/g, so 10% of 2000 kcal is 50 g. Stored as grams; the preset
 * buttons just re-derive the grams from the current calorie goal. It applies
 * to *added* sugar only, never to naturally-occurring total sugars.
 */
const SUGAR_KCAL_PER_G = 4
const SUGAR_PERCENT_OPTIONS = [10, 5] as const
function setSugarPercent(percent: number) {
  const goal = form.calorie_goal ?? 0
  if (!goal) return
  form.sugar_limit_g = Math.round((goal * (percent / 100)) / SUGAR_KCAL_PER_G)
}

/**
 * Which preset a stored sugar limit corresponds to, if any — the value the 10%
 * or 5% button would produce for the given calorie goal. Gram rounding means a
 * preset can read back a few tenths off the exact percentage (0.5 g up to
 * ~0.2 pp), so the match is tolerant. Used to decide whether a sugar limit
 * should follow the calorie goal when the target calculator changes it.
 */
function sugarPercentOf(calories: number, grams: number | null | undefined): number | null {
  if (!calories || !grams || !Number.isFinite(grams)) return null
  const pct = (grams * SUGAR_KCAL_PER_G * 100) / calories
  for (const option of SUGAR_PERCENT_OPTIONS) {
    if (Math.abs(pct - option) < 0.75) return option
  }
  return null
}

/**
 * The sugar limit as a % of the calorie goal, for the little indicator under
 * the field: if it lines up with the 10% / 5% preset, that button is
 * underlined; otherwise a faint "= X%" shows what the grams actually work out
 * to, so the number is never a mystery.
 */
const sugarCurrent = computed(() => {
  const goal = form.calorie_goal ?? 0
  const grams = form.sugar_limit_g
  if (!goal || !grams || !Number.isFinite(grams)) return null
  const pct = (grams * SUGAR_KCAL_PER_G * 100) / goal
  return { pct, preset: sugarPercentOf(goal, grams) }
})
const sugarLabel = computed(() => {
  if (!sugarCurrent.value) return null
  const rounded = Math.round(sugarCurrent.value.pct * 10) / 10
  return `${String(rounded)}%`
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <h1 class="font-semibold text-lg px-1">Settings</h1>

    <!-- About you ---------------------------------------------------------->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold">About you</h2>
        <p class="text-xs text-base-content/50">
          Used to estimate how many calories you burn. Optional — the diary
          works without it.
        </p>

        <div class="grid grid-cols-2 gap-2">
          <label class="form-control">
            <span class="label-text text-xs mb-1">Age</span>
            <input
              v-model.number="age"
              type="number" min="10" max="120" step="1" inputmode="numeric"
              class="input input-bordered input-sm w-full" placeholder="years"
              aria-label="Age"
            >
          </label>

          <label class="form-control">
            <span class="label-text text-xs mb-1">Gender</span>
            <select v-model="form.sex" class="select select-bordered select-sm w-full">
              <option :value="null">Not set</option>
              <option v-for="s in SEXES" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </label>
        </div>

        <div class="form-control">
          <span class="label-text text-xs mb-1">Height</span>
          <div class="join w-full">
            <template v-if="heightUnit === 'cm'">
              <input
                v-model.number="form.height_cm"
                type="number" min="50" max="260" step="any" inputmode="decimal"
                class="input input-bordered input-sm join-item flex-1" placeholder="cm"
                aria-label="Height in centimetres"
              >
            </template>
            <template v-else>
              <input
                v-model.number="feet"
                type="number" min="1" max="8" step="1" inputmode="numeric"
                class="input input-bordered input-sm join-item flex-1" placeholder="ft"
                aria-label="Height, feet"
              >
              <input
                v-model.number="inches"
                type="number" min="0" max="11" step="1" inputmode="numeric"
                class="input input-bordered input-sm join-item flex-1" placeholder="in"
                aria-label="Height, inches"
              >
            </template>
            <button
              v-for="u in ([['cm', 'cm'], ['ftin', 'ft/in']] as [HeightUnit, string][])"
              :key="u[0]"
              class="btn btn-sm join-item"
              :class="heightUnit === u[0] ? 'btn-neutral' : 'btn-outline'"
              :aria-pressed="heightUnit === u[0]"
              @click="heightUnit = u[0]"
            >{{ u[1] }}</button>
          </div>
        </div>

        <label class="form-control">
          <span class="label-text text-xs mb-1">Baseline Activity Level</span>
          <select
            v-model="form.activity_level"
            class="select select-bordered select-sm w-full"
          >
            <option :value="null">Not set</option>
            <!-- Label only: a select on a 390px screen clips the summary. -->
            <option v-for="a in ACTIVITY_LEVELS" :key="a.key" :value="a.key">
              {{ a.label }}
            </option>
          </select>
        </label>

        <p v-if="selectedActivity" class="text-xs text-base-content/60 leading-snug">
          <strong>{{ selectedActivity.summary }}.</strong>
          {{ selectedActivity.detail }}
        </p>

        <!-- The double-counting trap, named where the choice is made. -->
        <div v-if="activityIncludesExercise" class="alert alert-info text-xs py-2">
          <span>
            <strong>{{ selectedActivity?.label }}</strong> already includes your
            usual training in your daily burn. Don't log those normal sessions
            as exercise as well — only log activity <em>beyond</em> a typical
            week, like a race, a long hike or an unplanned extra session.
            <template v-if="form.exercise_adds_calories">
              You have "add exercise calories" switched on, so anything you log
              would be counted twice.
            </template>
          </span>
        </div>
      </div>
    </section>

    <!-- Weight ------------------------------------------------------------->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <div class="flex items-center justify-between gap-2">
          <h2 class="font-semibold">Today's weight</h2>
          <button class="btn btn-ghost btn-xs gap-1" @click="bmiOpen = true">
            <AppIcon name="ruler" class="w-4 h-4" />
            BMI
          </button>
        </div>
        <p class="text-xs text-base-content/50">
          Saved to today's diary and charted on Trends. To fix an earlier day,
          open it in the diary.
        </p>
        <div class="join w-full">
          <input
            v-model.number="weightDraft"
            type="number" min="10" step="any" inputmode="decimal"
            class="input input-bordered input-sm join-item flex-1"
            :placeholder="weightUnit" aria-label="Weight"
          >
          <button
            v-for="u in (['kg', 'lb'] as WeightUnit[])"
            :key="u"
            class="btn btn-sm join-item"
            :class="weightUnit === u ? 'btn-neutral' : 'btn-outline'"
            :aria-pressed="weightUnit === u"
            @click="weightUnit = u"
          >{{ u }}</button>
          <button
            class="btn btn-sm btn-primary join-item"
            :disabled="weightDraft === null || !today"
            @click="saveWeight"
          >
            <AppIcon v-if="weightSaved" name="check" class="w-4 h-4" />
            <span v-else>Log</span>
          </button>
        </div>
        <p v-if="data?.latest_weight" class="text-xs text-base-content/40">
          Last weigh-in
          {{ formatWeight(data.latest_weight.weight_kg, weightUnit) }}
          on {{ data.latest_weight.date }}.
        </p>
      </div>
    </section>

    <!-- Daily goals -------------------------------------------------------->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold">Daily goals</h2>

        <div class="flex flex-col gap-2">
          <label class="form-control">
            <span class="label-text text-xs mb-1">Daily calories (kcal)</span>
            <input
              v-model.number="form.calorie_goal"
              type="number" min="0" step="10" inputmode="numeric"
              class="input input-bordered input-sm w-full"
            >
          </label>

          <!-- Fibre and Added sugar side by side: both diet-shape numbers people track. -->
          <div class="grid grid-cols-2 gap-2">
            <label class="form-control">
              <span class="label-text text-xs mb-1">Fibre (g)</span>
              <input
                v-model.number="form.fiber_g"
                type="number" min="0" step="1" inputmode="numeric"
                class="input input-bordered input-sm w-full"
              >
            </label>
            <div class="form-control">
              <span class="label-text text-xs mb-1 flex items-center gap-1">
                Added sugar (g)
                <button
                  v-for="p in SUGAR_PERCENT_OPTIONS"
                  :key="p"
                  type="button"
                  class="btn btn-ghost btn-xs min-h-0 h-4 px-1 text-[10px] font-medium"
                  :class="{ 'underline underline-offset-2 decoration-base-content/70': sugarCurrent?.preset === p }"
                  :disabled="!form.calorie_goal"
                  :title="`${p}% of your ${form.calorie_goal ?? 0} kcal goal (sugar ≈ 4 kcal/g)`"
                  @click="setSugarPercent(p)"
                >{{ p }}%</button>
                <span v-if="sugarCurrent && sugarCurrent.preset === null" class="text-base-content/50 ml-2 text-[10px]">
                  = {{ sugarLabel }}
                </span>
              </span>
              <input
                v-model.number="form.sugar_limit_g"
                type="number" min="0" step="1" inputmode="numeric"
                class="input input-bordered input-sm w-full"
              >
            </div>
          </div>

          <label class="form-control">
            <span class="label-text text-xs mb-1">Water (ml)</span>
            <input
              v-model.number="form.water_goal_ml"
              type="number" min="0" step="50" inputmode="numeric"
              class="input input-bordered input-sm w-full"
            >
          </label>
        </div>

        <button
          class="btn btn-sm gap-2"
          :class="calorieGoalIsDefault ? 'btn-primary' : 'btn-outline'"
          :disabled="missingForCalculator.length > 0"
          @click="calculatorOpen = true"
        >
          <AppIcon name="chart" class="w-4 h-4" />
          Calculate calorie &amp; water targets
        </button>
        <p v-if="missingForCalculator.length" class="text-xs text-base-content/50">
          Add your {{ missingForCalculator.join(', ') }} above to calculate a target.
        </p>

        <div
          v-if="planSummary"
          class="rounded-box bg-base-200 p-3 flex items-start justify-between gap-2"
        >
          <div class="text-xs">
            <div class="font-medium">Your plan</div>
            <div class="text-base-content/60">{{ planSummary }}</div>
          </div>
          <button class="btn btn-ghost btn-xs" @click="clearPlan">Clear</button>
        </div>

        <!-- Macro split ------------------------------------------------->
        <div class="flex items-center justify-between gap-2 mt-1">
          <span class="label-text text-xs font-medium">Macro split</span>
          <button class="btn btn-ghost btn-xs" @click="applyDefaultSplit">
            Reset to {{ defaultSplitLabel }}
          </button>
        </div>

        <div class="flex flex-col gap-2">
          <div
            v-for="macro in MACROS"
            :key="macro.key"
            class="grid grid-cols-[4.5rem_1fr_1fr] gap-2 items-center"
          >
            <span class="text-xs">{{ macro.label }}</span>
            <label class="join w-full">
              <span class="sr-only">{{ macro.label }} percentage</span>
              <input
                :value="macroPercent(macro)"
                type="number" min="0" max="100" step="1" inputmode="numeric"
                class="input input-bordered input-sm join-item w-full tabular"
                @change="setMacroPercent(macro, Number(($event.target as HTMLInputElement).value))"
              >
              <span class="btn btn-sm join-item no-animation pointer-events-none">%</span>
            </label>
            <label class="join w-full">
              <span class="sr-only">{{ macro.label }} grams</span>
              <input
                v-model.number="form[macro.key]"
                type="number" min="0" step="1" inputmode="numeric"
                class="input input-bordered input-sm join-item w-full tabular"
              >
              <span class="btn btn-sm join-item no-animation pointer-events-none">g</span>
            </label>
          </div>
        </div>

        <p
          class="text-xs"
          :class="Math.abs(macroGap) > 50 ? 'text-warning' : 'text-base-content/50'"
        >
          {{ splitTotal }}% of your calorie goal — {{ macroCalories }} kcal
          <template v-if="Math.abs(macroGap) > 50">
            , {{ Math.abs(macroGap) }} kcal {{ macroGap > 0 ? 'above' : 'below' }} the
            {{ form.calorie_goal }} kcal you set.
          </template>
        </p>

        <label class="label cursor-pointer justify-start gap-3">
          <input
            v-model="form.exercise_adds_calories"
            type="checkbox" class="toggle toggle-sm"
            :true-value="1" :false-value="0"
          >
          <span class="label-text">Add exercise calories to my daily budget</span>
        </label>
      </div>
    </section>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold">Units</h2>

        <div class="form-control">
          <span class="label-text text-xs mb-1">Body measurements</span>
          <div role="tablist" class="tabs tabs-box tabs-sm">
            <button
              v-for="s in BODY_SYSTEMS" :key="s.value"
              role="tab" class="tab flex-1"
              :class="{ 'tab-active': bodySystem === s.value }"
              @click="bodySystem = s.value"
            >{{ s.label }}</button>
          </div>
          <p v-if="bodySystem === 'mixed'" class="text-xs text-base-content/50 mt-1">
            Currently mixed: height in {{ heightUnit === 'cm' ? 'centimetres' : 'feet and inches' }},
            weight in {{ weightUnit }}.
          </p>
        </div>

        <div class="form-control">
          <span class="label-text text-xs mb-1">Food measurements</span>
          <div role="tablist" class="tabs tabs-box tabs-sm">
            <button
              v-for="s in FOOD_SYSTEMS" :key="s.value"
              role="tab" class="tab flex-1"
              :class="{ 'tab-active': foodSystem === s.value }"
              @click="foodSystem = s.value"
            >{{ s.label }}</button>
          </div>
        </div>

        <p class="text-xs text-base-content/50">
          This only sets which unit a portion picker opens on — when logging a
          food you can enter the amount in grams, ounces, pounds, servings or
          whichever unit the packet uses, and Fittown shows what it works out to.
        </p>
      </div>
    </section>

    <!--
      These five save themselves the moment they're flipped, unlike everything
      above — a privacy control that needs a separate "Save settings" press is
      a control people believe they've already used.
    -->
    <section id="sharing" class="card bg-base-100 shadow-sm scroll-mt-20">
      <div class="card-body p-4 gap-3">
        <div>
          <h2 class="font-semibold">Sharing</h2>
          <p class="text-xs text-base-content/50 mt-0.5">
            What
            <NuxtLink to="/friends" class="link">your friends</NuxtLink>
            can see. Changes take effect immediately, for friends you already have.
          </p>
        </div>

        <label
          v-for="toggle in SHARE_TOGGLES"
          :key="toggle.key"
          class="flex items-start gap-3 cursor-pointer"
        >
          <input
            type="checkbox"
            class="toggle toggle-sm mt-0.5 shrink-0"
            :checked="sharing[toggle.key]"
            :disabled="sharingBusy === toggle.key"
            @change="setSharing(toggle.key, ($event.target as HTMLInputElement).checked)"
          >
          <span class="min-w-0">
            <span class="label-text text-sm block">{{ toggle.label }}</span>
            <span class="text-xs text-base-content/50 block">{{ toggle.description }}</span>
          </span>
        </label>

        <p class="text-xs text-base-content/50">
          A recipe you share with a
          <NuxtLink to="/recipes" class="link">public link</NuxtLink>
          stays readable by anyone holding that link, whatever these say — cancel
          the link on the recipe itself to stop it.
        </p>
      </div>
    </section>

    <button class="btn btn-primary gap-2" :disabled="saving" @click="save">
      <span v-if="saving" class="loading loading-spinner loading-sm" />
      <AppIcon v-else-if="saved" name="check" class="w-4 h-4" />
      {{ saved ? 'Saved' : 'Save settings' }}
    </button>

    <!--
      A joke, and deliberately a purely local one: nothing is sent anywhere and
      nothing is stored. Both buttons record a "Yes", which is the entire gag.
    -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold">
          Poll: should I add in-app full screen ads for diamond rings?
        </h2>

        <div class="flex gap-2">
          <button
            class="btn btn-sm flex-1"
            :class="pollVoted ? 'btn-primary' : 'btn-outline'"
            @click="pollVoted = true"
          >
            <AppIcon v-if="pollVoted" name="check" class="w-4 h-4" />
            Yes
          </button>
          <button
            class="btn btn-sm flex-1"
            :class="pollVoted ? 'btn-disabled' : 'btn-outline'"
            :disabled="pollVoted"
            @click="pollVoted = true"
          >
            No
          </button>
        </div>

        <p v-if="pollVoted" class="text-xs text-base-content/60">
          Thanks! You voted <strong>Yes</strong>. Due to how fast AI development is, expect these to start showing the next time you login.
        </p>
      </div>
    </section>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-2">
        <button class="btn btn-outline btn-sm mt-1" @click="signOut">Sign out</button>
      </div>
    </section>

    <CalorieTargetDialog
      v-if="missingForCalculator.length === 0"
      :open="calculatorOpen"
      :sex="(form.sex as Sex)"
      :age="age ?? 0"
      :height-cm="form.height_cm ?? 0"
      :weight-kg="currentWeightKg ?? 0"
      :activity="form.activity_level!"
      :weight-unit="weightUnit"
      :volume-unit="form.volume_unit ?? 'ml'"
      :macros="{
        protein_g: form.protein_g ?? 0,
        carbs_g: form.carbs_g ?? 0,
        fat_g: form.fat_g ?? 0,
      }"
      :current-calorie-goal="form.calorie_goal ?? 0"
      :today="today"
      :goal-weight-kg="form.goal_weight_kg ?? null"
      :goal-rate-kg-per-week="form.goal_rate_kg_per_week ?? null"
      @close="calculatorOpen = false"
      @apply="applyPlan"
    />

    <BmiDialog
      :open="bmiOpen"
      :value="bmiValue"
      :height-cm="form.height_cm ?? null"
      :weight-unit="weightUnit"
      @close="bmiOpen = false"
    />
  </div>
</template>

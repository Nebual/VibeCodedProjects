import type { NutrientTotals } from '#shared/nutrients'
import type { ActivityKey, HeightUnit, Sex, WeightUnit } from '#shared/body'
import type { MeasurementSystem } from '#shared/portions'
import type { EffortKey } from '#shared/activities'

export interface FoodRow {
  id: number
  /** 'recipe_log' is a recipe frozen at the moment it was logged. */
  source: 'off' | 'usda_foundation' | 'usda_branded' | 'custom' | 'recipe' | 'recipe_log'
  barcode: string | null
  name: string
  brand: string | null
  quantity: string | null
  image_url: string | null
  serving_size_text: string | null
  serving_grams: number | null
  is_liquid: number
  owner_user_id: number | null
  /** On someone else's food (a friend's shared custom food): the creator's name. */
  owner_name?: string | null
  /** Set when someone flagged this food as inaccurate; null otherwise. */
  reported_by?: number | null
  nutriscore: string | null
  kcal: number | null
  /** On a frozen meal: the live recipe it came from, if still there. */
  logged_from_food_id?: number | null
  /** On a frozen meal: what was changed for that one meal, in words. */
  recipe_log_note?: string | null
  /** Variants of one recipe share this. Null on a frozen meal. */
  recipe_family_id?: number | null
  /** Recipes only: how many servings it makes. Null on every other food. */
  recipe_servings: number | null
  /**
   * Recipes only: the finished yield, if it was weighed. Null means unknown,
   * which is what takes gram portions off the picker — see shared/recipes.ts.
   */
  recipe_final_weight_g: number | null
  [nutrient: string]: unknown
}

export interface DiaryEntry {
  id: number
  grams: number
  serving_label: string | null
  serving_count: number | null
  food: FoodRow
  nutrients: NutrientTotals
}

export interface Goals {
  calorie_goal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  fiber_g: number
  water_goal_ml: number
  /** Upper limit for sugar, in grams, the user stays under. */
  sugar_limit_g: number
  weight_unit: WeightUnit
  volume_unit: 'ml' | 'floz'
  /** Which portion unit the food picker starts on. */
  food_system: MeasurementSystem
  exercise_adds_calories: number
  // Body metrics — all null until the user fills them in on Settings.
  sex: Sex | null
  birth_year: number | null
  height_cm: number | null
  height_unit: HeightUnit
  activity_level: ActivityKey | null
  goal_weight_kg: number | null
  goal_rate_kg_per_week: number | null
  // What accepted friends may see. 0/1, defaulting to on — see shared/sharing.ts.
  share_recipes: number
  share_diary: number
  share_weight: number
  share_calories: number
  share_exercise: number
}

export interface BiometricRow {
  id: number
  name: string
  unit: string
  sort_order: number
  /** The reading for the day being viewed; null when nothing was recorded. */
  value: number | null
}

export interface WorkoutRow {
  id: number
  exercise_id: number
  exercise_name: string
  category: string
  duration_min: number | null
  calories: number | null
  effort: EffortKey | null
  sets: number | null
  reps: number | null
  weight_kg: number | null
  distance_km: number | null
  notes: string | null
}

export interface GoalSuggestion {
  weekly_avg_kcal: number
  suggested_goal_kcal: number
}

export interface DiaryDay {
  date: string
  meals: Record<string, DiaryEntry[]>
  totals: NutrientTotals
  water: {
    entries: { id: number; amount_ml: number }[]
    /** Auto-credited from drinks logged in the food diary — see server/utils/hydration.ts. */
    from_food_ml: number
    total_ml: number
  }
  workouts: { entries: WorkoutRow[]; total_calories: number; total_minutes: number }
  goals: Goals
  /** Present only when the past week's average is over goal and today hasn't answered yet. */
  goal_suggestion: GoalSuggestion | null
  weight_kg: number | null
  /** Most recent weigh-in on any date — what the calorie estimate uses. */
  latest_weight_kg: number | null
  biometrics: BiometricRow[]
}

export const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'] as const
export type MealName = (typeof MEAL_ORDER)[number]

export const MEAL_LABELS: Record<MealName, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snacks',
}

/**
 * Load and mutate a single diary day.
 *
 * Mutations re-fetch the whole day rather than patching local state: the
 * server owns all the nutrient maths, and a day is a couple of kilobytes, so
 * a round trip is cheaper than keeping a second copy of the rules in the client.
 */
export function useDiary(date: Ref<string | null>) {
  // `date` is null until the browser's timezone is known (see useToday). Both
  // server and client agree on that null, so the skeleton they render matches
  // and hydration stays clean; the real fetch fires as soon as it resolves.
  const ready = computed(() => date.value !== null)

  const { data, pending, error, refresh } = useFetch<DiaryDay>('/api/diary', {
    query: { date },
    watch: [date],
    immediate: ready.value,
    server: ready.value,
  })

  /** Mutations are only reachable from UI that already has a date. */
  function requireDate(): string {
    if (!date.value) throw new Error('No date selected')
    return date.value
  }

  async function addEntry(body: {
    meal: MealName
    food_id: number
    grams: number
    serving_label?: string | null
    serving_count?: number | null
  }) {
    await $fetch('/api/diary/entries', {
      method: 'POST',
      body: { date: requireDate(), ...body },
    })
    await refresh()
  }

  async function removeEntry(id: number) {
    await $fetch(`/api/diary/entries/${id}`, { method: 'DELETE' })
    await refresh()
  }

  async function updateEntry(id: number, body: Record<string, unknown>) {
    await $fetch(`/api/diary/entries/${id}`, { method: 'PATCH', body })
    await refresh()
  }

  async function addWater(amountMl: number) {
    await $fetch('/api/water', {
      method: 'POST',
      body: { date: requireDate(), amount_ml: amountMl },
    })
    await refresh()
  }

  async function addWorkout(body: Record<string, unknown>) {
    await $fetch('/api/workouts', {
      method: 'POST',
      body: { date: requireDate(), ...body },
    })
    await refresh()
  }

  async function removeWorkout(id: number) {
    await $fetch(`/api/workouts/${id}`, { method: 'DELETE' })
    await refresh()
  }

  /**
   * Record the weight for the day being viewed.
   *
   * Weight belongs to a day like any other entry, so logging it from the diary
   * — where you can navigate back to Tuesday and fix what you forgot — is the
   * same call Settings makes, just with a different date.
   */
  async function setWeight(weightKg: number) {
    await $fetch('/api/weight', {
      method: 'POST',
      body: { date: requireDate(), weight_kg: weightKg },
    })
    await refresh()
  }

  async function clearWeight() {
    await $fetch(`/api/weight/${requireDate()}`, { method: 'DELETE' })
    await refresh()
  }

  /** Record a custom measurement for this day. A null value clears it. */
  async function setBiometric(typeId: number, value: number | null) {
    await $fetch('/api/biometrics', {
      method: 'POST',
      body: { date: requireDate(), type_id: typeId, value },
    })
    await refresh()
  }

  async function addBiometricType(name: string, unit: string) {
    await $fetch('/api/biometrics/types', { method: 'POST', body: { name, unit } })
    await refresh()
  }

  async function removeBiometricType(typeId: number) {
    await $fetch(`/api/biometrics/types/${typeId}`, { method: 'DELETE' })
    await refresh()
  }

  async function answerGoalSuggestion(action: 'accept' | 'dismiss') {
    await $fetch('/api/diary/goal-suggestion', {
      method: 'POST',
      body: { date: requireDate(), action },
    })
    await refresh()
  }
  const acceptGoalSuggestion = () => answerGoalSuggestion('accept')
  const dismissGoalSuggestion = () => answerGoalSuggestion('dismiss')

  return {
    day: data,
    pending,
    error,
    refresh,
    addEntry,
    removeEntry,
    updateEntry,
    addWater,
    addWorkout,
    removeWorkout,
    setWeight,
    clearWeight,
    setBiometric,
    addBiometricType,
    removeBiometricType,
    acceptGoalSuggestion,
    dismissGoalSuggestion,
  }
}

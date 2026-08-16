import type { NutrientTotals } from '#shared/nutrients'

export interface FoodRow {
  id: number
  source: 'off' | 'custom'
  barcode: string | null
  name: string
  brand: string | null
  quantity: string | null
  image_url: string | null
  serving_size_text: string | null
  serving_grams: number | null
  is_liquid: number
  owner_user_id: number | null
  nutriscore: string | null
  kcal: number | null
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
  weight_unit: 'kg' | 'lb'
  volume_unit: 'ml' | 'floz'
  exercise_adds_calories: number
}

export interface WorkoutRow {
  id: number
  exercise_id: number
  exercise_name: string
  category: string
  duration_min: number | null
  calories: number | null
  sets: number | null
  reps: number | null
  weight_kg: number | null
  distance_km: number | null
  notes: string | null
}

export interface DiaryDay {
  date: string
  meals: Record<string, DiaryEntry[]>
  totals: NutrientTotals
  water: { entries: { id: number; amount_ml: number }[]; total_ml: number }
  workouts: { entries: WorkoutRow[]; total_calories: number; total_minutes: number }
  goals: Goals
  weight_kg: number | null
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
  }
}

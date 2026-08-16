<script setup lang="ts">
import { useDiary } from '~/composables/useDiary'

useHead({ title: 'Fitness · Fittown' })

const route = useRoute()
const router = useRouter()

const today = useToday()
const date = computed({
  get: () => (route.query.d as string) || today.value,
  set: (value: string | null) => {
    if (value) router.replace({ query: { ...route.query, d: value } })
  },
})

const { day, addWorkout, removeWorkout } = useDiary(date)

interface Exercise { id: number; name: string; category: string; met: number | null }
const search = ref('')
const { data: exerciseData } = await useFetch<{ results: Exercise[] }>('/api/exercises', {
  query: { q: search },
  watch: [search],
  default: () => ({ results: [] }),
})

const selected = ref<Exercise | null>(null)
const form = reactive({
  duration_min: 30 as number | null,
  calories: null as number | null,
  sets: null as number | null,
  reps: null as number | null,
  weight_kg: null as number | null,
  distance_km: null as number | null,
  notes: '',
})

const isStrength = computed(() => selected.value?.category === 'strength')

/**
 * Mirror the server's MET estimate so the number isn't a surprise after
 * saving. Falls back to 70 kg exactly as the API does when no weight is known.
 */
const estimated = computed(() => {
  const met = selected.value?.met
  if (!met || !form.duration_min) return null
  const kg = day.value?.weight_kg ?? 70
  return Math.round(met * kg * (form.duration_min / 60))
})

const saving = ref(false)

async function save() {
  if (!selected.value) return
  saving.value = true
  try {
    await addWorkout({ exercise_id: selected.value.id, ...form })
    selected.value = null
    Object.assign(form, {
      duration_min: 30, calories: null, sets: null, reps: null,
      weight_kg: null, distance_km: null, notes: '',
    })
    search.value = ''
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <DateNav v-model="date" :today="today" />

    <!-- Today's training -->
    <FitnessSection
      v-if="day"
      :workouts="day.workouts.entries"
      :total-calories="day.workouts.total_calories"
      :total-minutes="day.workouts.total_minutes"
      :date="date!"
      @remove="removeWorkout"
    />

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold">Log a workout</h2>

        <template v-if="!selected">
          <label class="input input-bordered flex items-center gap-2">
            <AppIcon name="search" class="w-4 h-4 opacity-50 shrink-0" />
            <input v-model="search" type="search" class="grow min-w-0" placeholder="Search activities…">
          </label>

          <ul class="max-h-80 overflow-y-auto divide-y divide-base-200 -mx-4">
            <li v-for="ex in exerciseData?.results ?? []" :key="ex.id">
              <button
                class="w-full text-left px-4 py-2.5 hover:bg-base-200 flex items-center gap-2"
                @click="selected = ex"
              >
                <span class="flex-1 text-sm">{{ ex.name }}</span>
                <span class="badge badge-ghost badge-sm">{{ ex.category }}</span>
              </button>
            </li>
          </ul>
        </template>

        <template v-else>
          <div class="flex items-center gap-2">
            <span class="font-medium flex-1">{{ selected.name }}</span>
            <button class="btn btn-ghost btn-xs" @click="selected = null">Change</button>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <label class="form-control">
              <span class="label-text text-xs mb-1">Duration (min)</span>
              <input v-model.number="form.duration_min" type="number" min="0" inputmode="numeric" class="input input-bordered input-sm w-full">
            </label>

            <label class="form-control">
              <span class="label-text text-xs mb-1">
                Calories
                <span v-if="form.calories === null && estimated" class="opacity-60">≈{{ estimated }}</span>
              </span>
              <input
                v-model.number="form.calories" type="number" min="0" inputmode="numeric"
                class="input input-bordered input-sm w-full"
                :placeholder="estimated ? String(estimated) : ''"
              >
            </label>

            <template v-if="isStrength">
              <label class="form-control">
                <span class="label-text text-xs mb-1">Sets</span>
                <input v-model.number="form.sets" type="number" min="0" inputmode="numeric" class="input input-bordered input-sm w-full">
              </label>
              <label class="form-control">
                <span class="label-text text-xs mb-1">Reps</span>
                <input v-model.number="form.reps" type="number" min="0" inputmode="numeric" class="input input-bordered input-sm w-full">
              </label>
              <label class="form-control">
                <span class="label-text text-xs mb-1">Weight (kg)</span>
                <input v-model.number="form.weight_kg" type="number" min="0" step="any" inputmode="decimal" class="input input-bordered input-sm w-full">
              </label>
            </template>

            <label v-else class="form-control">
              <span class="label-text text-xs mb-1">Distance (km)</span>
              <input v-model.number="form.distance_km" type="number" min="0" step="any" inputmode="decimal" class="input input-bordered input-sm w-full">
            </label>
          </div>

          <label class="form-control">
            <span class="label-text text-xs mb-1">Notes <span class="opacity-50">optional</span></span>
            <input v-model="form.notes" type="text" class="input input-bordered input-sm">
          </label>

          <button class="btn btn-success gap-2" :disabled="saving" @click="save">
            <span v-if="saving" class="loading loading-spinner loading-sm" />
            Add workout
          </button>
        </template>
      </div>
    </section>
  </div>
</template>

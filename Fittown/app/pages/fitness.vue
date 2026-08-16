<script setup lang="ts">
import { EFFORT_LEVELS, estimateCalories, type EffortKey } from '#shared/activities'
import type { Exercise } from '~/components/ActivityPicker.vue'
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

/**
 * Recently used activities, fetched here rather than inside the picker so it
 * can be refreshed the moment a workout is saved — the picker unmounts while
 * you fill in the form, and would otherwise come back showing a stale list.
 */
const { data: recentData, refresh: refreshRecent } = await useFetch<{ results: Exercise[] }>(
  '/api/exercises/recent',
  { default: () => ({ results: [] }) },
)
const recent = computed(() => recentData.value?.results ?? [])

const selected = ref<Exercise | null>(null)
const effort = ref<EffortKey>('moderate')

const form = reactive({
  duration_min: 30 as number | null,
  calories: null as number | null,
  sets: null as number | null,
  reps: null as number | null,
  weight_kg: null as number | null,
  distance_km: null as number | null,
  notes: '',
})

/** Only activities with measured light/hard rows get an effort picker. */
const hasEffort = computed(() => selected.value?.met_light !== null)
const tracksSets = computed(() => !!selected.value?.tracks_sets)
const tracksDistance = computed(() => !!selected.value?.tracks_distance)

/** The MET the server will use, mirrored so the estimate isn't a surprise. */
function metFor(level: EffortKey) {
  const ex = selected.value
  if (!ex) return null
  if (level === 'light') return ex.met_light ?? ex.met
  if (level === 'hard') return ex.met_hard ?? ex.met
  return ex.met
}

/**
 * Falls back the same way the API does: most recent weigh-in, then 70 kg.
 * Showing a number computed from a different weight than the one stored would
 * make the estimate look broken.
 */
const bodyKg = computed(() => day.value?.latest_weight_kg ?? 70)

function estimateFor(level: EffortKey) {
  const met = metFor(level)
  if (!met || !form.duration_min) return null
  return Math.round(estimateCalories(met, bodyKg.value, form.duration_min))
}

const estimated = computed(() => estimateFor(hasEffort.value ? effort.value : 'moderate'))

const effortDescription = computed(
  () => EFFORT_LEVELS.find((e) => e.key === effort.value)?.description ?? '',
)

function choose(exercise: Exercise) {
  selected.value = exercise
  effort.value = 'moderate'
}

const saving = ref(false)

async function save() {
  if (!selected.value) return
  saving.value = true
  try {
    await addWorkout({
      exercise_id: selected.value.id,
      effort: hasEffort.value ? effort.value : null,
      ...form,
    })
    await refreshRecent()
    selected.value = null
    Object.assign(form, {
      duration_min: 30, calories: null, sets: null, reps: null,
      weight_kg: null, distance_km: null, notes: '',
    })
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

        <ActivityPicker v-if="!selected" :recent="recent" @select="choose" />

        <template v-else>
          <div class="flex items-center gap-2">
            <span class="font-medium flex-1">{{ selected.name }}</span>
            <button class="btn btn-ghost btn-xs" @click="selected = null">Change</button>
          </div>

          <!-- Effort ------------------------------------------------------->
          <div v-if="hasEffort" class="flex flex-col gap-2">
            <span class="label-text text-xs">Effort</span>
            <div role="tablist" class="tabs tabs-box tabs-sm">
              <button
                v-for="level in EFFORT_LEVELS"
                :key="level.key"
                role="tab" class="tab flex-1 flex-col h-auto py-1.5"
                :class="{ 'tab-active': effort === level.key }"
                @click="effort = level.key"
              >
                <span class="text-xs font-medium">{{ level.label }}</span>
                <span v-if="estimateFor(level.key)" class="text-[0.6rem] opacity-60 tabular">
                  {{ estimateFor(level.key) }} kcal
                </span>
              </button>
            </div>
            <p class="text-xs text-base-content/60 leading-snug">
              {{ effortDescription }}
            </p>
            <p v-if="selected.hint" class="text-xs text-base-content/40 leading-snug">
              {{ selected.hint }}.
            </p>
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

            <template v-if="tracksSets">
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

            <label v-if="tracksDistance" class="form-control">
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

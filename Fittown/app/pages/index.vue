<script setup lang="ts">
import { MEAL_LABELS, MEAL_ORDER, useDiary } from '~/composables/useDiary'

useHead({ title: 'Diary · Fittown' })

const route = useRoute()
const router = useRouter()

const today = useToday()

// The date lives in the URL so a day is linkable and the back button works.
// Falls back to `today`, which is null until the browser's timezone is known.
const date = computed({
  get: () => (route.query.d as string) || today.value,
  set: (value: string | null) => {
    if (value) router.replace({ query: { ...route.query, d: value } })
  },
})

const {
  day, pending, error, removeEntry, addWater, removeWorkout,
} = useDiary(date)

const showMicros = ref(false)
</script>

<template>
  <div class="flex flex-col gap-3">
    <DateNav v-model="date" :today="today" />

    <div v-if="error" class="alert alert-error">
      <span>Couldn't load this day. {{ error.statusMessage || error.message }}</span>
    </div>

    <!-- Keep the previous day on screen while the next one loads, so
         navigating between days doesn't flash an empty page. -->
    <template v-if="day">
      <CalorieSummary
        :totals="day.totals"
        :goals="day.goals"
        :exercise-calories="day.workouts.total_calories"
      />

      <MealSection
        v-for="meal in MEAL_ORDER"
        :key="meal"
        :meal="meal"
        :label="MEAL_LABELS[meal]"
        :entries="day.meals[meal] ?? []"
        :date="date!"
        @remove="removeEntry"
      />

      <WaterTracker
        :total-ml="day.water.total_ml"
        :goal-ml="day.goals.water_goal_ml"
        :unit="day.goals.volume_unit"
        @add="addWater"
      />

      <FitnessSection
        :workouts="day.workouts.entries"
        :total-calories="day.workouts.total_calories"
        :total-minutes="day.workouts.total_minutes"
        :date="date!"
        @remove="removeWorkout"
      />

      <section class="card bg-base-100 shadow-sm">
        <button
          class="btn btn-ghost justify-between w-full"
          :aria-expanded="showMicros"
          @click="showMicros = !showMicros"
        >
          <span class="font-semibold">Full nutrition</span>
          <AppIcon
            name="chevronRight"
            class="w-4 h-4 transition-transform"
            :class="{ 'rotate-90': showMicros }"
          />
        </button>
        <div v-if="showMicros" class="card-body pt-0 p-4">
          <NutrientBreakdown :totals="day.totals" :goals="day.goals" />
        </div>
      </section>
    </template>

    <div v-else-if="pending" class="flex justify-center py-16">
      <span class="loading loading-spinner loading-lg text-primary" />
    </div>
  </div>
</template>

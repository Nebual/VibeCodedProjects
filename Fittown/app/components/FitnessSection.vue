<script setup lang="ts">
import type { WorkoutRow } from '~/composables/useDiary'

defineProps<{
  workouts: WorkoutRow[]
  totalCalories: number
  totalMinutes: number
  date: string
}>()

defineEmits<{ remove: [id: number] }>()

/** Compact summary line: "45 min · hard · 3×10 @ 60 kg · 5 km". */
function detail(w: WorkoutRow) {
  const bits: string[] = []
  if (w.duration_min) bits.push(`${Math.round(w.duration_min)} min`)
  if (w.effort) bits.push(w.effort)
  if (w.sets && w.reps) {
    bits.push(`${w.sets}×${w.reps}${w.weight_kg ? ` @ ${w.weight_kg} kg` : ''}`)
  }
  if (w.distance_km) bits.push(`${w.distance_km} km`)
  return bits.join(' · ')
}
</script>

<template>
  <section class="card bg-base-100 shadow-sm">
    <div class="card-body p-0">
      <header class="flex items-center justify-between px-4 pt-3 pb-1">
        <h2 class="font-semibold flex items-center gap-2">
          <AppIcon name="activity" class="w-4 h-4 text-success" />
          Fitness
        </h2>
        <span class="text-sm text-base-content/60 tabular">
          <template v-if="totalMinutes">{{ Math.round(totalMinutes) }} min · </template>
          {{ Math.round(totalCalories) }} kcal
        </span>
      </header>

      <ul v-if="workouts.length" class="divide-y divide-base-200">
        <li
          v-for="w in workouts"
          :key="w.id"
          class="flex items-center gap-3 px-4 py-2.5"
        >
          <div class="flex-1 min-w-0">
            <div class="truncate font-medium text-sm flex items-center gap-1.5">
              <AppIcon
                v-if="w.source === 'health_connect'"
                name="watch"
                class="w-3.5 h-3.5 text-base-content/40 shrink-0"
                title="Synced from your watch"
              />
              <span class="truncate">{{ w.exercise_name }}</span>
            </div>
            <div class="text-xs text-base-content/60 truncate">
              {{ detail(w) }}
              <span v-if="w.notes" class="text-base-content/40">· {{ w.notes }}</span>
            </div>
          </div>

          <div class="text-sm tabular text-success shrink-0">
            −{{ Math.round(w.calories ?? 0) }}
          </div>

          <button
            class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
            :aria-label="`Remove ${w.exercise_name}`"
            @click="$emit('remove', w.id)"
          >
            <AppIcon name="trash" class="w-4 h-4" />
          </button>
        </li>
      </ul>

      <p v-else class="px-4 pb-1 text-sm text-base-content/40">No training logged.</p>

      <NuxtLink
        :to="`/fitness?d=${date}`"
        class="btn btn-ghost btn-sm justify-start gap-2 m-2 mt-1 text-success"
      >
        <AppIcon name="plus" class="w-4 h-4" />
        Log workout
      </NuxtLink>
    </div>
  </section>
</template>

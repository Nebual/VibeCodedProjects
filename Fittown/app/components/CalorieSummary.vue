<script setup lang="ts">
import type { NutrientTotals } from '#shared/nutrients'
import type { Goals } from '~/composables/useDiary'

const props = defineProps<{
  totals: NutrientTotals
  goals: Goals
  exerciseCalories: number
}>()

const eaten = computed(() => Math.round(props.totals.kcal ?? 0))

/**
 * Exercise calories only widen the budget if the user opted in. Doing it
 * unconditionally is how trackers end up encouraging people to "eat back"
 * an estimate that's often wildly optimistic.
 */
const budget = computed(() =>
  props.goals.exercise_adds_calories
    ? props.goals.calorie_goal + props.exerciseCalories
    : props.goals.calorie_goal,
)

const remaining = computed(() => Math.round(budget.value - eaten.value))
const over = computed(() => remaining.value < 0)

const percent = computed(() =>
  Math.min(100, Math.round((eaten.value / Math.max(budget.value, 1)) * 100)),
)

const macros = computed(() => [
  { key: 'protein_g', label: 'Protein', value: props.totals.protein_g ?? 0, goal: props.goals.protein_g, cls: 'bg-macro-protein' },
  { key: 'carbs_g', label: 'Carbs', value: props.totals.carbs_g ?? 0, goal: props.goals.carbs_g, cls: 'bg-macro-carbs' },
  { key: 'fat_g', label: 'Fat', value: props.totals.fat_g ?? 0, goal: props.goals.fat_g, cls: 'bg-macro-fat' },
])
</script>

<template>
  <section class="card bg-base-100 shadow-sm">
    <div class="card-body p-4 gap-4">
      <div class="flex items-center gap-4">
        <div
          class="radial-progress shrink-0 tabular"
          :class="over ? 'text-error' : 'text-primary'"
          :style="`--value:${percent}; --size:5.5rem; --thickness:0.55rem`"
          role="progressbar"
          :aria-valuenow="percent"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`${percent}% of calorie budget used`"
        >
          <div class="text-center leading-tight">
            <div class="text-lg font-semibold">{{ eaten }}</div>
            <div class="text-[0.65rem] text-base-content/60">kcal</div>
          </div>
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex items-baseline gap-2">
            <span
              class="text-2xl font-semibold tabular"
              :class="over ? 'text-error' : ''"
            >{{ Math.abs(remaining) }}</span>
            <span class="text-sm text-base-content/70">
              kcal {{ over ? 'over' : 'left' }}
            </span>
          </div>

          <div class="text-xs text-base-content/60 mt-1 tabular">
            <span>{{ goals.calorie_goal }} goal</span>
            <span v-if="goals.exercise_adds_calories && exerciseCalories > 0">
              + {{ Math.round(exerciseCalories) }} exercise
            </span>
            <span> − {{ eaten }} eaten</span>
          </div>
        </div>
      </div>

      <!-- Macro bars -->
      <div class="grid grid-cols-3 gap-3">
        <div v-for="m in macros" :key="m.key">
          <div class="flex justify-between text-xs mb-1">
            <span class="text-base-content/70">{{ m.label }}</span>
            <span class="tabular">{{ Math.round(m.value) }}<span class="text-base-content/50">/{{ Math.round(m.goal) }}g</span></span>
          </div>
          <div class="h-1.5 rounded-full bg-base-300 overflow-hidden">
            <div
              class="h-full rounded-full transition-all"
              :class="m.cls"
              :style="`width:${Math.min(100, (m.value / Math.max(m.goal, 1)) * 100)}%`"
            />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

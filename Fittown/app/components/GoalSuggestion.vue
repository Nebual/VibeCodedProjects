<script setup lang="ts">
import type { GoalSuggestion } from '~/composables/useDiary'

const props = defineProps<{ suggestion: GoalSuggestion }>()
defineEmits<{ accept: []; dismiss: [] }>()

const weeklyAvg = computed(() => Math.round(props.suggestion.weekly_avg_kcal))
const suggestedGoal = computed(() => Math.round(props.suggestion.suggested_goal_kcal))
</script>

<template>
  <section class="alert bg-base-100 shadow-sm items-start gap-3">
    <AppIcon name="chart" class="w-5 h-5 shrink-0 mt-0.5 text-primary" />
    <div class="flex-1 min-w-0">
      <p class="text-sm">
        You've averaged <span class="font-semibold tabular">{{ weeklyAvg }}</span> kcal/day
        this week. Lower today's goal to <span class="font-semibold tabular">{{ suggestedGoal }}</span>?
      </p>
      <div class="flex gap-2 mt-2">
        <button class="btn btn-primary btn-sm" @click="$emit('accept')">
          Lower today's goal
        </button>
        <button class="btn btn-ghost btn-sm" @click="$emit('dismiss')">Dismiss</button>
      </div>
    </div>
  </section>
</template>

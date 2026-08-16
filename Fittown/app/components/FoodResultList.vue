<script setup lang="ts">
import type { FoodRow } from '~/composables/useDiary'

const props = defineProps<{
  foods: (FoodRow & { times_logged?: number })[]
  meal: string
  date: string | null
}>()

/** Omit `d` entirely rather than emitting `d=null`, which the API rejects. */
const linkFor = (id: number) =>
  `/food/${id}?meal=${props.meal}${props.date ? `&d=${props.date}` : ''}`

/** Energy shown per default serving when there is one, else per 100 g. */
function energyLine(food: FoodRow) {
  const unit = food.is_liquid ? 'ml' : 'g'
  const per100 = food.kcal
  if (per100 === null || per100 === undefined) return 'No energy data'

  if (food.serving_grams) {
    const perServing = Math.round((per100 * food.serving_grams) / 100)
    return `${perServing} kcal · ${Math.round(food.serving_grams)} ${unit} serving`
  }
  return `${Math.round(per100)} kcal / 100 ${unit}`
}
</script>

<template>
  <ul class="flex flex-col divide-y divide-base-200">
    <li v-for="food in foods" :key="food.id">
      <NuxtLink
        :to="linkFor(food.id)"
        class="flex items-center gap-3 px-3 py-2.5 hover:bg-base-200 transition-colors"
      >
        <div class="flex-1 min-w-0">
          <div class="font-medium text-sm truncate">
            {{ food.name }}
            <span
              v-if="food.source === 'custom'"
              class="badge badge-xs badge-secondary align-middle"
            >custom</span>
          </div>
          <div class="text-xs text-base-content/60 truncate">
            <span v-if="food.brand">{{ food.brand }} · </span>{{ energyLine(food) }}
          </div>
        </div>

        <div
          v-if="food.times_logged"
          class="text-[0.65rem] text-base-content/40 shrink-0 tabular"
        >
          ×{{ food.times_logged }}
        </div>
        <AppIcon name="chevronRight" class="w-4 h-4 text-base-content/30 shrink-0" />
      </NuxtLink>
    </li>
  </ul>
</template>

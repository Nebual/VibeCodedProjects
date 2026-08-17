<script setup lang="ts">
import { isRecipe, showsGramPortions } from '#shared/recipes'
import type { FoodRow } from '~/composables/useDiary'

const props = withDefaults(
  defineProps<{
    foods: (FoodRow & { times_logged?: number })[]
    meal?: string
    date?: string | null
    /** Set when picking an ingredient: results go into this recipe instead. */
    recipe?: number | null
    /** Set when replacing an existing ingredient rather than adding one. */
    ingredient?: number | null
    /**
     * Extra query parameters to carry to the portion picker — the amount an
     * ingredient already has, so swapping its food doesn't reset it.
     */
    extra?: Record<string, string>
  }>(),
  { meal: 'snack', date: null, recipe: null, ingredient: null, extra: () => ({}) },
)

const linkFor = (id: number) =>
  `/food/${id}?${foodLinkQuery({
    meal: props.meal,
    date: props.date,
    recipe: props.recipe,
    ingredient: props.ingredient,
    extra: props.extra,
  })}`

/**
 * Energy shown per default serving when there is one, else per 100 g.
 *
 * A recipe with no stated yield gets the serving without the weight: its
 * internal basis is the raw ingredient sum, which is not what the finished dish
 * weighs, so quoting it here would be inventing a number.
 */
function energyLine(food: FoodRow) {
  const unit = food.is_liquid ? 'ml' : 'g'
  const per100 = food.kcal
  if (per100 === null || per100 === undefined) return 'No energy data'

  const servingGrams = food.serving_grams
  if (servingGrams) {
    const perServing = Math.round((per100 * servingGrams) / 100)
    return showsGramPortions(food)
      ? `${perServing} kcal · ${Math.round(servingGrams)} ${unit} serving`
      : `${perServing} kcal per serving`
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
              v-if="isRecipe(food)"
              class="badge badge-xs badge-primary align-middle"
            >recipe</span>
            <span
              v-else-if="food.source === 'custom'"
              class="badge badge-xs badge-secondary align-middle"
            >custom</span>
            <span
              v-if="!isRecipe(food) && !food.serving_grams"
              class="badge badge-xs badge-ghost align-middle"
            >no serving size</span>
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

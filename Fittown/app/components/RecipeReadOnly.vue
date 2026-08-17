<script setup lang="ts">
import { baseUnit, roundGrams } from '#shared/portions'
import { showsGramPortions } from '#shared/recipes'
import type { RecipeDetail, RecipeIngredient } from '~/composables/useRecipes'

/**
 * Somebody else's recipe, as read by a friend or by whoever opened a share
 * link. Deliberately not the editor with the inputs disabled: there is nothing
 * to save here, and editing a recipe you don't own would rewrite meals its
 * owner has already logged (a diary entry holds no nutrient snapshot).
 *
 * Same numbers as the owner sees — `recipeDetail()` on the server assembles
 * both — so a copied recipe can't come out different to the one on screen.
 */
defineProps<{
  detail: RecipeDetail
  /** Whose recipe this is, shown as provenance. */
  ownerName?: string | null
}>()

const view = ref<'serving' | 'whole'>('serving')

/** "1.5 × cup · 240 g" — the same sentence the diary and the editor show. */
function portionText(ingredient: RecipeIngredient) {
  const unit = ingredient.food.is_liquid ? 'ml' : 'g'
  const grams = `${roundGrams(ingredient.grams)} ${unit}`
  if (ingredient.serving_label && ingredient.serving_count) {
    const count = Number(ingredient.serving_count.toFixed(2))
    return `${count} × ${ingredient.serving_label} · ${grams}`
  }
  return grams
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-1">
        <div class="flex items-baseline gap-2 flex-wrap">
          <span class="text-sm text-base-content/60 tabular">
            {{ detail.recipe.recipe_servings ?? 1 }}
            {{ (detail.recipe.recipe_servings ?? 1) === 1 ? 'serving' : 'servings' }}
          </span>
          <span v-if="ownerName" class="text-sm text-base-content/60">
            · from {{ ownerName }}
          </span>
        </div>

        <p v-if="detail.recipe.serving_grams && showsGramPortions(detail.recipe)" class="text-xs text-base-content/60 tabular">
          One serving is {{ roundGrams(detail.recipe.serving_grams) }}
          {{ baseUnit(!!detail.recipe.is_liquid) }}.
        </p>
        <p v-else class="text-xs text-base-content/60">
          Measured in servings — nobody weighed the finished dish.
        </p>
      </div>
    </section>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-0">
        <header class="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 class="font-semibold">Ingredients</h2>
          <span class="text-sm text-base-content/60 tabular">
            {{ roundGrams(detail.raw_g) }} {{ baseUnit(!!detail.recipe.is_liquid) }} in
          </span>
        </header>

        <ul v-if="detail.ingredients.length" class="divide-y divide-base-200">
          <li
            v-for="ingredient in detail.ingredients"
            :key="ingredient.id"
            class="flex items-center gap-3 px-4 py-2.5"
          >
            <div class="flex-1 min-w-0">
              <div class="truncate font-medium text-sm">{{ ingredient.food.name }}</div>
              <div class="text-xs text-base-content/60 truncate tabular">
                <span v-if="ingredient.food.brand">{{ ingredient.food.brand }} · </span>
                {{ portionText(ingredient) }}
              </div>
            </div>
            <div class="text-sm tabular shrink-0">
              {{ Math.round(ingredient.nutrients.kcal ?? 0) }}
            </div>
          </li>
        </ul>

        <p v-else class="px-4 pb-3 text-sm text-base-content/40">Nothing in it yet.</p>
      </div>
    </section>

    <slot name="actions" />

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="font-semibold">Nutrition</h2>
          <span class="text-2xl font-semibold tabular">
            {{ Math.round((view === 'serving' ? detail.per_serving : detail.totals).kcal ?? 0) }}
            <span class="text-sm font-normal text-base-content/60">kcal</span>
          </span>
        </div>

        <div role="tablist" class="tabs tabs-box">
          <button
            role="tab"
            class="tab flex-1 text-xs"
            :class="{ 'tab-active': view === 'serving' }"
            @click="view = 'serving'"
          >
            Per serving
          </button>
          <button
            role="tab"
            class="tab flex-1 text-xs"
            :class="{ 'tab-active': view === 'whole' }"
            @click="view = 'whole'"
          >
            Whole recipe
          </button>
        </div>

        <NutrientBreakdown :totals="view === 'serving' ? detail.per_serving : detail.totals" />
      </div>
    </section>
  </div>
</template>

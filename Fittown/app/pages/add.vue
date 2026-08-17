<script setup lang="ts">
import type { FoodRow } from '~/composables/useDiary'
import { MEAL_LABELS, type MealName } from '~/composables/useDiary'
import type { RecipeSummary } from '~/composables/useRecipes'
import type { FriendRecipeResult } from '~/composables/useFriends'
import { friendDisplayName } from '#shared/friends'

const route = useRoute()
const meal = computed(() => (route.query.meal as MealName) || 'snack')
const today = useToday()

const date = computed(() => (route.query.d as string) || today.value)

/**
 * Set when this screen is picking an *ingredient* for a recipe rather than
 * something to eat now. Same search, same scanner, only the destination and
 * the recipe list (a recipe can't yet contain another) differ.
 */
const recipeId = computed(() => (route.query.recipe ? Number(route.query.recipe) : null))

useHead({
  title: () =>
    recipeId.value
      ? 'Add ingredient · Fittown'
      : `Add to ${MEAL_LABELS[meal.value] ?? 'diary'} · Fittown`,
})

const query = ref('')
const debounced = ref('')

// Debounce so a fast typist doesn't fire a query per keystroke.
let timer: ReturnType<typeof setTimeout> | undefined
watch(query, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    debounced.value = value.trim()
  }, 220)
})
onBeforeUnmount(() => clearTimeout(timer))

const { data: searchData, pending: searching } = await useFetch<{
  results: FoodRow[]
  friend_results: FriendRecipeResult[]
}>('/api/foods/search', {
  // `exclude_recipes` means "I'm picking an ingredient", which is the one case
  // where a recipe — yours or a friend's — can't be the answer. Otherwise
  // recipes come back and the sections below de-duplicate them by id.
  query: { q: debounced, exclude_recipes: computed(() => (recipeId.value ? 1 : 0)) },
  watch: [debounced],
  immediate: false,
  default: () => ({ results: [], friend_results: [] }),
})

const { data: mealRecentData } = await useFetch<{ results: FoodRow[] }>('/api/foods/recent', {
  query: { meal },
  default: () => ({ results: [] }),
})

/** Everything recently logged, any meal — used to fill out "Frequent" below the meal-specific rows. */
const { data: allRecentData } = await useFetch<{ results: FoodRow[] }>('/api/foods/recent', {
  default: () => ({ results: [] }),
})

const { data: recipeData } = await useFetch<{ recipes: RecipeSummary[] }>('/api/recipes', {
  default: () => ({ recipes: [] }),
  // Nothing to browse here when we're already inside a recipe.
  immediate: !recipeId.value,
})

/** Case-insensitive match against name/brand; an empty query matches everything. */
function matches(text: string, food: { name: string; brand?: string | null }) {
  if (!text) return true
  const q = text.toLowerCase()
  return food.name.toLowerCase().includes(q) || (food.brand ?? '').toLowerCase().includes(q)
}

const mealFrequent = computed(() =>
  (mealRecentData.value?.results ?? []).filter((f) => matches(debounced.value, f)),
)
const mealFrequentIds = computed(() => new Set(mealFrequent.value.map((f) => f.id)))

/** Frequent items from other meals, appended after this meal's own — never duplicated. */
const otherFrequent = computed(() =>
  (allRecentData.value?.results ?? [])
    .filter((f) => !mealFrequentIds.value.has(f.id))
    .filter((f) => matches(debounced.value, f)),
)

const frequent = computed(() => [...mealFrequent.value, ...otherFrequent.value])

const recipes = computed(() =>
  (recipeData.value?.recipes ?? []).filter((f) => matches(debounced.value, f)),
)

/** What a query already surfaced above — raw search results never repeat it. */
const shownIds = computed(() => {
  const ids = new Set(frequent.value.map((f) => f.id))
  for (const r of recipes.value) ids.add(r.id)
  return ids
})

const searchResults = computed(() =>
  (searchData.value?.results ?? []).filter((f) => !shownIds.value.has(f.id)),
)

/**
 * Friends' recipes, under everything of your own.
 *
 * They aren't loggable rows — tapping one opens the friend's recipe, which
 * offers to copy it into yours first. Mixing them into the ranking above would
 * put things in the list that the portion picker can't accept.
 */
const friendResults = computed(() => searchData.value?.friend_results ?? [])

const nothingFound = computed(
  () =>
    !frequent.value.length
    && !recipes.value.length
    && !searchResults.value.length
    && !friendResults.value.length
    && !searching.value,
)

/** Opens the friend's recipe, carrying the meal so "Log food" lands right. */
function friendRecipeLink(recipe: FriendRecipeResult) {
  const params = new URLSearchParams({ meal: meal.value })
  if (date.value) params.set('d', date.value)
  return `/friends/${recipe.owner_id}/recipes/${recipe.id}?${params}`
}

const newFoodLink = computed(
  () => `/food/new?${foodLinkQuery({ meal: meal.value, date: date.value, recipe: recipeId.value })}`,
)

const showScanner = ref(false)
</script>

<template>
  <div class="flex flex-col gap-3">
    <header class="flex items-center gap-2">
      <button class="btn btn-ghost btn-sm btn-square" aria-label="Back" @click="$router.back()">
        <AppIcon name="chevronLeft" class="w-5 h-5" />
      </button>
      <h1 class="font-semibold flex-1">
        {{ recipeId ? 'Add ingredient' : `Add to ${MEAL_LABELS[meal]}` }}
      </h1>
    </header>

    <div class="flex gap-2">
      <label class="input input-bordered flex items-center gap-2 flex-1">
        <AppIcon name="search" class="w-4 h-4 opacity-50 shrink-0" />
        <input
          v-model="query"
          type="search"
          class="grow min-w-0"
          placeholder="Search foods…"
          autocomplete="off"
        >
        <span v-if="searching" class="loading loading-spinner loading-xs" />
      </label>

      <button
        class="btn btn-outline btn-square"
        aria-label="Scan barcode"
        @click="showScanner = true"
      >
        <AppIcon name="barcode" class="w-5 h-5" />
      </button>
    </div>

    <div class="card bg-base-100 shadow-sm overflow-hidden">
      <template v-if="frequent.length">
        <header class="px-3 pt-2.5 pb-1 text-xs font-semibold text-base-content/50 uppercase tracking-wide">
          Frequent
        </header>
        <FoodResultList :foods="frequent" :meal="meal" :date="date" :recipe="recipeId" />
      </template>

      <template v-if="!recipeId && recipes.length">
        <header
          class="px-3 pt-2.5 pb-1 text-xs font-semibold text-base-content/50 uppercase tracking-wide"
          :class="{ 'border-t border-base-200 mt-1': frequent.length }"
        >
          Recipes
        </header>
        <FoodResultList
          :foods="(recipes as unknown as FoodRow[])"
          :meal="meal"
          :date="date"
        />
      </template>

      <template v-if="searchResults.length">
        <header
          class="px-3 pt-2.5 pb-1 text-xs font-semibold text-base-content/50 uppercase tracking-wide"
          :class="{ 'border-t border-base-200 mt-1': frequent.length || recipes.length }"
        >
          Search results
        </header>
        <FoodResultList :foods="searchResults" :meal="meal" :date="date" :recipe="recipeId" />
      </template>

      <template v-if="friendResults.length">
        <header
          class="px-3 pt-2.5 pb-1 text-xs font-semibold text-base-content/50 uppercase tracking-wide"
          :class="{ 'border-t border-base-200 mt-1': frequent.length || recipes.length || searchResults.length }"
        >
          From friends
        </header>
        <ul class="flex flex-col divide-y divide-base-200">
          <li v-for="recipe in friendResults" :key="`friend-${recipe.id}`">
            <NuxtLink
              :to="friendRecipeLink(recipe)"
              class="flex items-center gap-3 px-3 py-2.5 hover:bg-base-200 transition-colors"
            >
              <div class="flex-1 min-w-0">
                <div class="font-medium text-sm truncate">
                  {{ recipe.name }}
                  <span class="badge badge-xs badge-primary align-middle">recipe</span>
                </div>
                <div class="text-xs text-base-content/60 truncate">
                  {{ friendDisplayName({ name: recipe.owner_name, email: recipe.owner_email }) }}
                  <template v-if="recipe.kcal !== null && recipe.serving_grams">
                    · {{ Math.round((recipe.kcal * recipe.serving_grams) / 100) }} kcal per serving
                  </template>
                </div>
              </div>
              <AppIcon name="chevronRight" class="w-4 h-4 text-base-content/30 shrink-0" />
            </NuxtLink>
          </li>
        </ul>
      </template>

      <p v-if="nothingFound" class="p-6 text-center text-sm text-base-content/50">
        <template v-if="debounced.length >= 2">No matches for “{{ debounced }}”.</template>
        <template v-else>Foods you log will appear here for quick re-adding.</template>
      </p>
    </div>

    <NuxtLink v-if="!recipeId" to="/recipes" class="btn btn-outline gap-2">
      <AppIcon name="plus" class="w-4 h-4" />
      Create a new recipe
    </NuxtLink>

    <NuxtLink :to="newFoodLink" class="btn btn-outline gap-2">
      <AppIcon name="plus" class="w-4 h-4" />
      Create a custom food
    </NuxtLink>

    <BarcodeScanner
      v-if="showScanner"
      :meal="meal"
      :date="date"
      :recipe="recipeId"
      @close="showScanner = false"
    />
  </div>
</template>

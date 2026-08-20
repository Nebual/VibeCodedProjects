<script setup lang="ts">
import { friendDisplayName, friendInitial } from '#shared/friends'
import { sharesNothing } from '#shared/sharing'
import { MEAL_LABELS, type MealName } from '~/composables/useDiary'
import {
  type FriendCustomFoodList,
  type FriendProfile,
  type FriendRecipeList,
  apiError,
} from '~/composables/useFriends'
import type { NutrientTotals } from '#shared/nutrients'
import { roundGrams } from '#shared/portions'

/**
 * A friend's page: their trends, their recipes, and what they ate.
 *
 * Everything here is read-only, and every section is conditional on what they
 * chose to share in Settings. The conditions are a courtesy — the endpoints
 * behind them refuse on their own — but a page that quietly draws three empty
 * cards is its own kind of wrong.
 */

const route = useRoute()
const id = computed(() => Number(route.params.id))

const { data: profile, error } = await useFetch<FriendProfile>(() => `/api/friends/${id.value}`)

const friend = computed(() => profile.value?.friend)
const permissions = computed(() => profile.value?.permissions)
const name = computed(() => (friend.value ? friendDisplayName(friend.value) : 'Friend'))

useHead({ title: () => `${name.value} · Fittown` })

const showsTrends = computed(
  () =>
    !!permissions.value
    && (permissions.value.share_calories
      || permissions.value.share_weight
      || permissions.value.share_exercise),
)

type Tab = 'trends' | 'recipes' | 'foods' | 'diary'

const tabs = computed(() => {
  const out: { key: Tab; label: string }[] = []
  if (showsTrends.value) out.push({ key: 'trends', label: 'Trends' })
  if (permissions.value?.share_recipes) out.push({ key: 'recipes', label: 'Recipes' })
  if (permissions.value?.share_custom_foods) out.push({ key: 'foods', label: 'Foods' })
  if (permissions.value?.share_diary) out.push({ key: 'diary', label: 'Diary' })
  return out
})

const tab = ref<Tab>('trends')
watchEffect(() => {
  // Land on whatever they do share rather than on an empty first tab.
  if (tabs.value.length && !tabs.value.some((t) => t.key === tab.value)) {
    tab.value = tabs.value[0]!.key
  }
})

// --- recipes ----------------------------------------------------------------

const { data: recipeData, execute: loadRecipes } = await useFetch<FriendRecipeList>(
  () => `/api/friends/${id.value}/recipes`,
  {
    default: () => ({ recipes: [] }) as unknown as FriendRecipeList,
    immediate: false,
  },
)

// --- custom foods -----------------------------------------------------------

const { data: foodsData, execute: loadFoods } = await useFetch<FriendCustomFoodList>(
  () => `/api/friends/${id.value}/custom-foods`,
  {
    default: () => ({ foods: [] }) as unknown as FriendCustomFoodList,
    immediate: false,
  },
)

const copyingFoodId = ref<number | null>(null)
const copyError = ref<string | null>(null)

async function copyFood(foodId: number) {
  copyingFoodId.value = foodId
  copyError.value = null
  try {
    await $fetch<{ id: number }>('/api/foods/copy', {
      method: 'POST',
      body: { friend_id: id.value, food_id: foodId },
    })
  } catch (err) {
    copyError.value = apiError(err, 'Could not copy that food')
  } finally {
    copyingFoodId.value = null
  }
}

// --- diary ------------------------------------------------------------------

const today = useToday()
const date = ref<string | null>(null)
watchEffect(() => {
  if (!date.value && today.value) date.value = today.value
})

interface FriendDiaryEntry {
  id: number
  grams: number
  serving_label: string | null
  serving_count: number | null
  food: { id: number; name: string; brand: string | null; is_liquid: number }
  nutrients: NutrientTotals
}

interface FriendDay {
  date: string
  meals: Record<string, FriendDiaryEntry[]>
  totals: NutrientTotals
  water_ml: number
  workouts: {
    id: number
    exercise_name: string
    duration_min: number | null
    calories: number | null
  }[]
}

const { data: dayData, execute: loadDay } = await useFetch<FriendDay>(
  () => `/api/friends/${id.value}/diary`,
  {
    query: { date },
    // Driven by the watcher below instead, so switching away from the Diary
    // tab and back doesn't refetch, and a date change only counts while the
    // tab is actually open.
    watch: false,
    immediate: false,
  },
)

/**
 * The secondary tabs fetch on first view rather than up front.
 *
 * Opening a friend costs one small request; the recipe list and a day's meals
 * are only worth fetching for the tab someone actually taps.
 */
const loadedRecipes = ref(false)
const loadedFoods = ref(false)

watch(
  [tab, date],
  ([current]) => {
    if (current === 'recipes' && !loadedRecipes.value) {
      loadedRecipes.value = true
      loadRecipes()
    }
    if (current === 'foods' && !loadedFoods.value) {
      loadedFoods.value = true
      loadFoods()
    }
    if (current === 'diary' && date.value) loadDay()
  },
  { immediate: true },
)

const MEAL_ORDER: MealName[] = ['breakfast', 'lunch', 'dinner', 'snack']

function portionText(entry: FriendDiaryEntry) {
  const unit = entry.food.is_liquid ? 'ml' : 'g'
  const grams = `${roundGrams(entry.grams)} ${unit}`
  if (entry.serving_label && entry.serving_count) {
    return `${Number(entry.serving_count.toFixed(2))} × ${entry.serving_label} · ${grams}`
  }
  return grams
}
</script>

<template>
  <div v-if="error" class="alert alert-error">
    <span>That isn’t one of your friends.</span>
  </div>

  <div v-else-if="friend" class="flex flex-col gap-3">
    <header class="flex items-center gap-2">
      <NuxtLink to="/friends" class="btn btn-ghost btn-sm btn-square" aria-label="Back to friends">
        <AppIcon name="chevronLeft" class="w-5 h-5" />
      </NuxtLink>
      <div class="avatar avatar-placeholder">
        <div class="w-9 rounded-full bg-neutral text-neutral-content grid place-items-center">
          <img v-if="friend.avatar_url" :src="friend.avatar_url" :alt="name">
          <span v-else class="text-sm">{{ friendInitial(friend) }}</span>
        </div>
      </div>
      <h1 class="font-semibold flex-1 truncate">{{ name }}</h1>
    </header>

    <p
      v-if="permissions && sharesNothing(permissions)"
      class="text-center text-sm text-base-content/50 py-10"
    >
      {{ name }} isn’t sharing anything at the moment.
    </p>

    <template v-else>
      <div v-if="tabs.length > 1" role="tablist" class="tabs tabs-box">
        <button
          v-for="t in tabs"
          :key="t.key"
          role="tab"
          class="tab flex-1"
          :class="{ 'tab-active': tab === t.key }"
          @click="tab = t.key"
        >{{ t.label }}</button>
      </div>

      <!-- Trends ------------------------------------------------------------>
      <TrendsPanel
        v-if="tab === 'trends' && showsTrends"
        :source="`/api/friends/${id}/summary`"
        :who="name"
      >
        <template #title>
          <h2 class="font-semibold">Trends</h2>
        </template>
      </TrendsPanel>

      <!-- Recipes ----------------------------------------------------------->
      <div v-else-if="tab === 'recipes'" class="card bg-base-100 shadow-sm overflow-hidden">
        <ul v-if="recipeData?.recipes.length" class="divide-y divide-base-200">
          <li v-for="recipe in recipeData.recipes" :key="recipe.id">
            <NuxtLink
              :to="`/friends/${id}/recipes/${recipe.id}`"
              class="flex items-center gap-3 px-3 py-2.5 hover:bg-base-200 transition-colors"
            >
              <div class="flex-1 min-w-0">
                <div class="font-medium text-sm truncate">{{ recipe.name }}</div>
                <div class="text-xs text-base-content/60 truncate tabular">
                  <template v-if="recipe.ingredient_count === 0">No ingredients yet</template>
                  <template v-else>
                    {{ recipe.ingredient_count }}
                    {{ recipe.ingredient_count === 1 ? 'ingredient' : 'ingredients' }}
                    <template v-if="recipe.kcal_per_serving !== null">
                      · {{ Math.round(recipe.kcal_per_serving) }} kcal each
                    </template>
                  </template>
                </div>
              </div>
              <AppIcon name="chevronRight" class="w-4 h-4 text-base-content/30 shrink-0" />
            </NuxtLink>
          </li>
        </ul>
        <p v-else class="p-6 text-center text-sm text-base-content/50">
          {{ name }} hasn’t written any recipes yet.
        </p>
      </div>

      <!-- Custom foods -------------------------------------------------------->
      <div v-else-if="tab === 'foods'" class="card bg-base-100 shadow-sm overflow-hidden">
        <p v-if="copyError" class="px-4 pt-3 text-xs text-error">{{ copyError }}</p>
        <ul v-if="foodsData?.foods.length" class="divide-y divide-base-200">
          <li
            v-for="food in foodsData.foods"
            :key="food.id"
            class="flex items-center gap-3 px-3 py-2.5"
          >
            <div class="flex-1 min-w-0">
              <div class="font-medium text-sm truncate">
                <template v-if="food.brand">{{ food.brand }} · {{ food.name }}</template>
                <template v-else>{{ food.name }}</template>
              </div>
              <div class="text-xs text-base-content/60 truncate tabular">
                <template v-if="food.kcal !== null">{{ Math.round(food.kcal) }} kcal / 100 {{ food.is_liquid ? 'ml' : 'g' }}</template>
                <template v-else>Nutrition not recorded</template>
              </div>
            </div>
            <button
              class="btn btn-outline btn-sm gap-1.5 shrink-0"
              :disabled="copyingFoodId === food.id"
              @click="copyFood(food.id)"
            >
              <span v-if="copyingFoodId === food.id" class="loading loading-spinner loading-xs" />
              <AppIcon v-else name="plus" class="w-4 h-4" />
              <span class="hidden sm:inline">Add to mine</span>
            </button>
          </li>
        </ul>
        <p v-else class="p-6 text-center text-sm text-base-content/50">
          {{ name }} hasn’t made any custom foods yet.
        </p>
      </div>

      <!-- Diary ------------------------------------------------------------->
      <div v-else-if="tab === 'diary'" class="flex flex-col gap-3">
        <div class="card bg-base-100 shadow-sm">
          <div class="card-body p-2">
            <DateNav v-model="date" :today="today" />
          </div>
        </div>

        <div class="stats stats-horizontal bg-base-100 shadow-sm w-full">
          <div class="stat p-3">
            <div class="stat-title text-xs">Eaten</div>
            <div class="stat-value text-xl tabular">
              {{ Math.round(dayData?.totals?.kcal ?? 0) }}
            </div>
            <div class="stat-desc text-xs">kcal</div>
          </div>
          <div class="stat p-3">
            <div class="stat-title text-xs">Water</div>
            <div class="stat-value text-xl tabular">{{ Math.round(dayData?.water_ml ?? 0) }}</div>
            <div class="stat-desc text-xs">ml</div>
          </div>
        </div>

        <section
          v-for="meal in MEAL_ORDER"
          :key="meal"
          class="card bg-base-100 shadow-sm overflow-hidden"
        >
          <header class="px-4 pt-3 pb-1 font-semibold text-sm">{{ MEAL_LABELS[meal] }}</header>
          <ul v-if="dayData?.meals?.[meal]?.length" class="divide-y divide-base-200">
            <li
              v-for="entry in dayData.meals[meal]"
              :key="entry.id"
              class="flex items-center gap-3 px-4 py-2"
            >
              <div class="flex-1 min-w-0">
                <div class="text-sm truncate">{{ entry.food.name }}</div>
                <div class="text-xs text-base-content/60 truncate tabular">
                  <span v-if="entry.food.brand">{{ entry.food.brand }} · </span>
                  {{ portionText(entry) }}
                </div>
              </div>
              <div class="text-sm tabular shrink-0">
                {{ Math.round(entry.nutrients.kcal ?? 0) }}
              </div>
            </li>
          </ul>
          <p v-else class="px-4 pb-3 text-sm text-base-content/40">Nothing logged.</p>
        </section>

        <section
          v-if="dayData?.workouts?.length"
          class="card bg-base-100 shadow-sm overflow-hidden"
        >
          <header class="px-4 pt-3 pb-1 font-semibold text-sm">Training</header>
          <ul class="divide-y divide-base-200">
            <li
              v-for="workout in dayData.workouts"
              :key="workout.id"
              class="flex items-center gap-3 px-4 py-2"
            >
              <span class="flex-1 min-w-0 truncate text-sm">{{ workout.exercise_name }}</span>
              <span class="text-xs text-base-content/60 tabular">
                <template v-if="workout.duration_min">{{ workout.duration_min }} min</template>
              </span>
              <span class="text-sm tabular text-success shrink-0">
                {{ Math.round(workout.calories ?? 0) }}
              </span>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>

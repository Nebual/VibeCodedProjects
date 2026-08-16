<script setup lang="ts">
import { scaleNutrients } from '#shared/nutrients'
import { isRecipe } from '#shared/recipes'
import type { FoodRow, Goals, MealName } from '~/composables/useDiary'
import { MEAL_LABELS, MEAL_ORDER } from '~/composables/useDiary'
import type { FoodServing, PortionSelection } from '~/composables/usePortionOptions'
import { usePortionOptions } from '~/composables/usePortionOptions'

const route = useRoute()
const router = useRouter()

const foodId = computed(() => Number(route.params.id))
const today = useToday()
const date = computed(() => (route.query.d as string) || today.value)
/** Present when editing an existing diary row rather than adding a new one. */
const entryId = computed(() => (route.query.entry ? Number(route.query.entry) : null))

/**
 * Present when this food is going into a recipe instead of the diary. The
 * journey is identical — search, scan, pick a portion — so it reuses this page
 * rather than duplicating it, exactly as `?entry=` reuses it for edits.
 */
const recipeId = computed(() => (route.query.recipe ? Number(route.query.recipe) : null))
const ingredientId = computed(() =>
  route.query.ingredient ? Number(route.query.ingredient) : null,
)

const meal = ref<MealName>((route.query.meal as MealName) || 'snack')

const { data, error } = await useFetch<{ food: FoodRow; servings: FoodServing[] }>(
  () => `/api/foods/${foodId.value}`,
)

const food = computed(() => data.value?.food)
useHead({ title: () => `${food.value?.name ?? 'Food'} · Fittown` })

// The unit preference only decides which option is selected first — every
// option stays available, because a recipe mixes units freely.
const { data: settings } = await useFetch<{ goals: Goals }>('/api/goals')
const system = computed(() => settings.value?.goals?.food_system ?? 'metric')

/**
 * The portion this row was saved with, when re-opening one. Carried in the URL
 * by whoever linked here, so the picker can land on "2 × cup" instead of
 * resetting to a default the user never chose.
 */
const initial = computed<PortionSelection | null>(() => {
  if (!entryId.value && !ingredientId.value) return null
  const grams = Number(route.query.g)
  if (!Number.isFinite(grams) || grams <= 0) return null
  const count = Number(route.query.sc)
  return {
    grams,
    serving_label: (route.query.sl as string) || null,
    serving_count: Number.isFinite(count) && count > 0 ? count : null,
  }
})

/**
 * The picker's state lives here, not inside the component: this page renders
 * the nutrition preview from the same grams, and it has to have them before it
 * renders or the server and the client disagree about what a portion contains.
 */
const picker = usePortionOptions(
  food,
  computed(() => data.value?.servings ?? []),
  system,
  initial,
)

const preview = computed(() =>
  food.value ? scaleNutrients(food.value as Record<string, unknown>, picker.grams) : {},
)

const editingRecipe = computed(() => isRecipe(food.value ?? {}))

const saving = ref(false)
const saveError = ref<string | null>(null)

const saveLabel = computed(() => {
  if (recipeId.value) return ingredientId.value ? 'Save ingredient' : 'Add to recipe'
  return entryId.value ? 'Save changes' : `Add to ${MEAL_LABELS[meal.value]}`
})

async function save() {
  if (!food.value || picker.grams <= 0) return
  saving.value = true
  saveError.value = null

  // Grams are what gets stored; the label and count ride along only so the
  // row can redisplay "4 × oz" instead of "113 g".
  const body = { ...picker.selection }

  try {
    if (recipeId.value) {
      if (ingredientId.value) {
        await $fetch(`/api/recipes/${recipeId.value}/ingredients/${ingredientId.value}`, {
          method: 'PATCH',
          body,
        })
      } else {
        await $fetch(`/api/recipes/${recipeId.value}/ingredients`, {
          method: 'POST',
          body: { food_id: food.value.id, ...body },
        })
      }
      await router.push(`/recipes/${recipeId.value}`)
      return
    }

    if (entryId.value) {
      await $fetch(`/api/diary/entries/${entryId.value}`, {
        method: 'PATCH',
        body: { ...body, meal: meal.value },
      })
    } else {
      await $fetch('/api/diary/entries', {
        method: 'POST',
        body: { date: date.value, meal: meal.value, food_id: food.value.id, ...body },
      })
    }
    await router.push(date.value ? `/?d=${date.value}` : '/')
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save'
    saving.value = false
  }
}

async function remove() {
  saving.value = true
  if (recipeId.value && ingredientId.value) {
    await $fetch(`/api/recipes/${recipeId.value}/ingredients/${ingredientId.value}`, {
      method: 'DELETE',
    })
    await router.push(`/recipes/${recipeId.value}`)
    return
  }
  if (!entryId.value) return
  await $fetch(`/api/diary/entries/${entryId.value}`, { method: 'DELETE' })
  await router.push(date.value ? `/?d=${date.value}` : '/')
}

const canRemove = computed(() => !!entryId.value || !!ingredientId.value)
</script>

<template>
  <div v-if="error" class="alert alert-error">
    <span>Food not found.</span>
  </div>

  <div v-else-if="food" class="flex flex-col gap-3">
    <header class="flex items-start gap-2">
      <button class="btn btn-ghost btn-sm btn-square" aria-label="Back" @click="router.back()">
        <AppIcon name="chevronLeft" class="w-5 h-5" />
      </button>
      <div class="flex-1 min-w-0 pt-1">
        <h1 class="font-semibold leading-tight">{{ food.name }}</h1>
        <p v-if="food.brand" class="text-sm text-base-content/60 truncate">{{ food.brand }}</p>
      </div>
    </header>

    <!-- Portion -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <PortionPicker :picker="picker">
          <label v-if="!recipeId" class="form-control">
            <span class="label-text text-xs mb-1">Meal</span>
            <div role="tablist" class="tabs tabs-box">
              <button
                v-for="m in MEAL_ORDER"
                :key="m"
                role="tab"
                class="tab flex-1 text-xs"
                :class="{ 'tab-active': meal === m }"
                @click="meal = m"
              >
                {{ MEAL_LABELS[m] }}
              </button>
            </div>
          </label>
        </PortionPicker>
      </div>
    </section>

    <!-- What that portion contains -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <div class="flex items-baseline justify-between">
          <h2 class="font-semibold">In this portion</h2>
          <span class="text-2xl font-semibold tabular">
            {{ Math.round(preview.kcal ?? 0) }}
            <span class="text-sm font-normal text-base-content/60">kcal</span>
          </span>
        </div>
        <NutrientBreakdown :totals="preview" />
      </div>
    </section>

    <NuxtLink
      v-if="editingRecipe && !recipeId"
      :to="`/recipes/${food.id}`"
      class="btn btn-ghost btn-sm gap-2 self-start"
    >
      <AppIcon name="pencil" class="w-4 h-4" />
      Edit this recipe
    </NuxtLink>

    <div v-if="saveError" class="alert alert-error text-sm">{{ saveError }}</div>

    <div class="flex gap-2">
      <button
        v-if="canRemove"
        class="btn btn-outline btn-error"
        :disabled="saving"
        :aria-label="ingredientId ? 'Remove ingredient' : 'Remove entry'"
        @click="remove"
      >
        <AppIcon name="trash" class="w-4 h-4" />
      </button>
      <button
        class="btn btn-primary flex-1 gap-2"
        :disabled="saving || picker.grams <= 0"
        @click="save"
      >
        <span v-if="saving" class="loading loading-spinner loading-sm" />
        {{ saveLabel }}
      </button>
    </div>
  </div>
</template>

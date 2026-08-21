<script setup lang="ts">
import { scaleNutrients } from '#shared/nutrients'
import { canReportFood, reportedFoodHidden } from '#shared/reported'
import {
  WHOLE_RECIPE_LABEL,
  applyAdjustments,
  isRecipe,
  isRecipeLog,
  recipeServingGrams,
  rollUpRecipe,
  type RecipeAdjustment,
} from '#shared/recipes'
import type { RecipeDetail } from '~/composables/useRecipes'
import type { FoodRow, Goals, MealName } from '~/composables/useDiary'
import { MEAL_LABELS, MEAL_ORDER } from '~/composables/useDiary'
import type { FoodServing, PortionSelection } from '~/composables/usePortionOptions'
import { usePortionOptions } from '~/composables/usePortionOptions'

const route = useRoute()
const router = useRouter()

const foodId = computed(() => Number(route.params.id))
// Logging food after midnight belongs on yesterday's page — same late-night
// rule as the diary itself.
const diaryDay = useDiaryDay()
const date = computed(() => (route.query.d as string) || diaryDay.value)
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

/**
 * Is this ingredient a suggestion rather than part of the dish?
 *
 * Carried in the URL by the recipe editor, the same way the portion is, so this
 * page doesn't need to fetch the recipe to know. Marking one optional belongs
 * here rather than in the list: it is an edit to the ingredient, and the list
 * row's job is the one-tap version — switching it on and off.
 */
const optional = ref(route.query.opt === '1')

const { data, error } = await useFetch<{ food: FoodRow; servings: FoodServing[] }>(
  () => `/api/foods/${foodId.value}`,
)

const food = computed(() => data.value?.food)
useHead({ title: () => `${food.value?.name ?? 'Food'} · Fittown` })

// --- report as inaccurate --------------------------------------------------
// A reported food leaves search for the household; the owner of a custom food
// still sees their own. The button must not appear where the action is refused
// (a USDA Foundation Food, or your own custom food). A reported food is still
// reachable by its direct URL, so the page has to handle a food somebody else
// already flagged (notice, no action) as well as one you flagged (undo).
const { user: sessionUser } = useUserSession()
const userId = computed(() => sessionUser.value?.id ?? 0)
const reportable = computed(
  () => !!food.value && canReportFood(food.value as never, userId.value),
)
/** A custom food's owner viewing their own flagged food: show the notice, not a report button. */
const ownerReportedNotice = computed(
  () =>
    !!food.value
    && !reportable.value
    && food.value.source === 'custom'
    && food.value.owner_user_id === userId.value
    && reportedFoodHidden(food.value as never, userId.value),
)
const reportBusy = ref(false)
const reportError = ref<string | null>(null)
/** Someone has flagged this food; the page offers Undo to anyone who visits. */
const reported = ref(Boolean(data.value?.food?.reported_by))

async function report() {
  reportBusy.value = true
  reportError.value = null
  try {
    await $fetch(`/api/foods/${foodId.value}/report`, { method: 'POST' })
    reported.value = true
  } catch (err) {
    reportError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not report this food'
  } finally {
    reportBusy.value = false
  }
}

async function unreport() {
  reportBusy.value = true
  reportError.value = null
  try {
    await $fetch(`/api/foods/${foodId.value}/report`, { method: 'DELETE' })
    reported.value = false
  } catch (err) {
    reportError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not undo that report'
  } finally {
    reportBusy.value = false
  }
}

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
// --- adjusting a recipe for this meal ---------------------------------------

/**
 * Which recipe's ingredients this screen can adjust, if any.
 *
 * Fetched here in `setup`, not lazily when the panel opens: an adjusted recipe
 * weighs something else, so the portion picker's grams depend on it, and
 * `usePortionOptions` has to have them before the first render or the server and
 * the client disagree about what a serving contains (see the note at the bottom
 * of that composable).
 */
const adjustableRecipeId = computed(() => {
  const value = food.value
  if (!value || !isRecipe(value) || recipeId.value) return null
  return isRecipeLog(value) ? null : value.id
})

const { data: recipeData } = await useFetch<RecipeDetail>(
  () => `/api/recipes/${adjustableRecipeId.value}`,
  { immediate: !!adjustableRecipeId.value },
)

/** A meal already logged, read back so it can be corrected. */
const { data: entryData } = await useFetch<{ detail: RecipeDetail | null }>(
  () => `/api/diary/entries/${entryId.value}`,
  { immediate: !!entryId.value && isRecipeLog(food.value ?? {}) },
)

const adjustable = computed(() => recipeData.value?.ingredients ?? entryData.value?.detail?.ingredients ?? null)

const adjustments = ref<RecipeAdjustment[]>([])
const showAdjuster = ref(false)

/**
 * The food as this meal will actually be — the recipe's own row when nothing is
 * adjusted, and a re-rolled version of it when something is.
 *
 * Overlaid rather than fetched: `rollUpRecipe()` is the same function the server
 * will use on the frozen copy, so the preview and the stored figures agree, and
 * the portion picker keeps working on an ordinary-looking food row.
 */
const adjustedFood = computed(() => {
  const base = food.value
  if (!base || adjustments.value.length === 0 || !adjustable.value) return base

  const lookup = (id: number) =>
    (adjustable.value!.find((row) => row.food?.id === id)?.food ?? null) as
      | Record<string, unknown>
      | null

  const rolled = rollUpRecipe(
    applyAdjustments(adjustable.value as never[], adjustments.value, lookup),
    base.recipe_final_weight_g as number | null,
  )
  const servings = Number(base.recipe_servings ?? 1) || 1

  return {
    ...base,
    ...rolled.per100,
    serving_grams: recipeServingGrams(rolled.basis_g, servings),
    /** Carried so the "whole recipe" option below can be resized with it. */
    __basis_g: rolled.basis_g,
  } as typeof base & { __basis_g?: number }
})

/**
 * The named portions, resized when the meal has been adjusted.
 *
 * `food_servings` holds "whole recipe" at the recipe's own weight; three eggs
 * instead of four makes that a different number, and a picker offering the old
 * one would log a portion nobody ate.
 */
const servingOptions = computed(() => {
  const list = data.value?.servings ?? []
  const basis = (adjustedFood.value as { __basis_g?: number } | undefined)?.__basis_g
  if (basis === undefined) return list
  return list.map((serving) =>
    serving.label === WHOLE_RECIPE_LABEL ? { ...serving, grams: basis } : serving,
  )
})

const picker = usePortionOptions(adjustedFood, servingOptions, system, initial)

const preview = computed(() =>
  adjustedFood.value
    ? scaleNutrients(adjustedFood.value as Record<string, unknown>, picker.grams)
    : {},
)

/**
 * Where "edit this recipe" goes, or null when there is nowhere to send them.
 *
 * A frozen meal is a recipe by every display rule but is not editable, and
 * `/recipes/{id}` would 404 on it. Its own source recipe is the useful
 * destination — unless that has since been deleted, in which case the frozen
 * copy is all that is left of it and there is nothing to offer.
 */
const recipeLink = computed(() => {
  const value = food.value
  if (!value || !isRecipe(value) || recipeId.value) return null
  if (!isRecipeLog(value)) return `/recipes/${value.id}`
  return value.logged_from_food_id ? `/recipes/${value.logged_from_food_id}` : null
})

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
          // `food_id` matters when the row didn't have one: this is how an
          // imported line the matcher wasn't sure about gets its food. Sending
          // it when the row already points here is a harmless no-op.
          //
          // `is_optional` is sent every time rather than only when it changed:
          // the route turns a cleared flag back into "counted", which is the
          // behaviour that needs to happen on the way back as well.
          body: { ...body, food_id: food.value.id, is_optional: optional.value },
        })
      } else {
        await $fetch(`/api/recipes/${recipeId.value}/ingredients`, {
          method: 'POST',
          body: { food_id: food.value.id, ...body, is_optional: optional.value },
        })
      }
      await router.push(`/recipes/${recipeId.value}`)
      return
    }

    if (entryId.value) {
      await $fetch(`/api/diary/entries/${entryId.value}`, {
        method: 'PATCH',
        body: { ...body, meal: meal.value, adjustments: adjustments.value },
      })
    } else {
      await $fetch('/api/diary/entries', {
        method: 'POST',
        body: {
          date: date.value,
          meal: meal.value,
          food_id: food.value.id,
          ...body,
          // Empty means "as written", which is almost every meal.
          adjustments: adjustments.value,
        },
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

// --- keeping an adjustment -----------------------------------------------

/**
 * Turn this meal's changes into a recipe of their own.
 *
 * The point at which "three eggs today" becomes "this is how I make it". The
 * variant is a sibling of the recipe it came from, so either one leads back to
 * the other, and the log that follows uses the variant — otherwise saving it
 * would leave you looking at a recipe you aren't about to eat.
 */
const variantName = ref('')
const savingVariant = ref(false)

async function saveAsVariant() {
  if (!food.value || adjustments.value.length === 0) return
  savingVariant.value = true
  saveError.value = null
  try {
    const { id } = await $fetch<{ id: number }>(`/api/recipes/${food.value.id}/variants`, {
      method: 'POST',
      body: { name: variantName.value.trim() || undefined, adjustments: adjustments.value },
    })
    await router.push(`/recipes/${id}`)
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save'
    savingVariant.value = false
  }
}
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
          <label v-if="recipeId" class="label cursor-pointer justify-start gap-3 py-0">
            <input v-model="optional" type="checkbox" class="toggle toggle-sm">
            <span class="label-text text-sm">
              Optional — suggest it, don’t count it
            </span>
          </label>

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

    <!-- Adjusting the recipe for this one meal. Collapsed by default: logging a
         recipe as written should stay two taps, and it is what happens almost
         every time. -->
    <section v-if="adjustable" class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <button
          class="flex items-center gap-2 text-left"
          :aria-expanded="showAdjuster"
          @click="showAdjuster = !showAdjuster"
        >
          <div class="flex-1 min-w-0">
            <h2 class="font-semibold text-sm">
              {{ entryId ? 'What was in it' : 'Adjust for this meal' }}
            </h2>
            <p class="text-xs text-base-content/50">
              <template v-if="adjustments.length">
                {{ adjustments.length }}
                {{ adjustments.length === 1 ? 'change' : 'changes' }} — the recipe stays as it is
              </template>
              <template v-else>
                Fewer eggs, no bacon, a bit more cheese — just this once
              </template>
            </p>
          </div>
          <AppIcon
            :name="showAdjuster ? 'minus' : 'plus'"
            class="w-4 h-4 text-base-content/40 shrink-0"
          />
        </button>

        <template v-if="showAdjuster">
          <RecipeAdjuster
            :ingredients="adjustable"
            @update:adjustments="adjustments = $event"
          />

          <!-- Only once something has changed: an empty name box on a screen
               nobody is naming anything on is just clutter. -->
          <div v-if="adjustments.length && !entryId" class="flex flex-col gap-2 pt-1">
            <div class="flex gap-2">
              <input
                v-model="variantName"
                type="text"
                class="input input-bordered input-sm flex-1 min-w-0"
                :placeholder="`${food.name} (my way)`"
                aria-label="Name for the variant"
              >
              <button
                class="btn btn-outline btn-sm gap-2"
                :disabled="savingVariant"
                @click="saveAsVariant"
              >
                <span v-if="savingVariant" class="loading loading-spinner loading-xs" />
                Save as a variant
              </button>
            </div>
            <p class="text-xs text-base-content/50">
              Keeps these changes as a recipe variant, linked to this one.
            </p>
          </div>
        </template>
      </div>
    </section>

    <NuxtLink
      v-if="recipeLink"
      :to="recipeLink"
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
        <NutrientBreakdown :totals="preview" :goals="settings?.goals" />

        <!-- Report as inaccurate. A subdued action on the place you're already
             reading the numbers; right-aligned so it never crowds the breakdown. -->
        <div
          v-if="reportable || ownerReportedNotice"
          class="flex items-center justify-end gap-2 pt-1"
        >
          <span
            v-if="ownerReportedNotice"
            class="text-xs text-base-content/60"
          >Reported — hidden from everyone else</span>
          <template v-else-if="reportable">
            <button
              v-if="!reported"
              class="btn btn-outline btn-error btn-sm gap-1.5"
              :disabled="reportBusy"
              @click="report"
            >
              <AppIcon name="flag" class="w-3.5 h-3.5" />
              Report as inaccurate
            </button>
            <div v-else class="flex items-center gap-2">
              <span class="text-xs text-base-content/60">Hidden from search</span>
              <button
                class="btn btn-ghost btn-sm"
                :disabled="reportBusy"
                @click="unreport"
              >Undo report</button>
            </div>
          </template>
        </div>
        <p v-if="reportError" class="text-xs text-error text-right">{{ reportError }}</p>
      </div>
    </section>
  </div>
</template>

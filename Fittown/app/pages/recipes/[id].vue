<script setup lang="ts">
import { MASS_UNITS, VOLUME_UNITS, baseUnit, portionUnits, roundGrams, type PortionUnit } from '#shared/portions'
import { MAX_INSTRUCTIONS_CHARS, showsGramPortions } from '#shared/recipes'
import { sharedRecipeUrl } from '#shared/friends'
import {
  ingredientDetail,
  ingredientName,
  ingredientSearchTerm,
  isNestedRecipe,
  isResolved,
} from '~/utils/ingredients'
import type { RecipeDetail, RecipeIngredient } from '~/composables/useRecipes'

const route = useRoute()
const router = useRouter()
// "Log a serving" should land on the diary's effective day, so a late-night
// log goes on yesterday's page rather than a brand-new today.
const diaryDay = useDiaryDay()

const id = computed(() => Number(route.params.id))

const { data, error, refresh } = await useFetch<RecipeDetail>(() => `/api/recipes/${id.value}`)

const recipe = computed(() => data.value?.recipe)
useHead({ title: () => `${recipe.value?.name ?? 'Recipe'} · Fittown` })

const isLiquid = computed(() => !!recipe.value?.is_liquid)
const unit = computed(() => baseUnit(isLiquid.value))
const servings = computed(() => Number(recipe.value?.recipe_servings ?? 1))
const showsGrams = computed(() => (recipe.value ? showsGramPortions(recipe.value) : false))

const saving = ref(false)
const saveError = ref<string | null>(null)

async function patch(body: Record<string, unknown>) {
  saving.value = true
  saveError.value = null
  try {
    await $fetch(`/api/recipes/${id.value}`, { method: 'PATCH', body })
    await refresh()
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save'
  } finally {
    saving.value = false
  }
}

// --- name -------------------------------------------------------------------

const name = ref('')
const servingsInput = ref(1)
const instructions = ref('')
watch(
  recipe,
  (value) => {
    if (!value) return
    name.value = String(value.name ?? '')
    servingsInput.value = Number(value.recipe_servings ?? 1)
    instructions.value = String(value.recipe_instructions ?? '')
  },
  { immediate: true },
)

/**
 * Saved on blur like the other fields. Deliberately not on every keystroke:
 * this is the one box someone types paragraphs into.
 */
function saveInstructions() {
  const next = instructions.value.trim()
  if (next === String(recipe.value?.recipe_instructions ?? '')) return
  patch({ instructions: next === '' ? null : next })
}

function saveName() {
  const next = name.value.trim()
  if (next.length < 1 || next === recipe.value?.name) return
  patch({ name: next })
}

function saveServings() {
  const next = Number(servingsInput.value)
  if (!Number.isFinite(next) || next <= 0 || next === servings.value) return
  patch({ servings: next })
}

// --- final weight -----------------------------------------------------------

/**
 * Units for the yield field. The "100 g" pseudo-unit is dropped: it exists to
 * make portion picking convenient, and nobody weighs a finished dish in it.
 */
const weightUnits = computed(() =>
  (isLiquid.value ? VOLUME_UNITS : MASS_UNITS).filter((u) => u.size !== 100),
)
const weightUnitKey = ref(baseUnit(false))
const weightAmount = ref<number | null>(null)

watch(
  [recipe, isLiquid],
  () => {
    if (!recipe.value) return
    if (!weightUnits.value.some((u) => u.key === weightUnitKey.value)) {
      weightUnitKey.value = baseUnit(isLiquid.value)
    }
    const grams = recipe.value.recipe_final_weight_g as number | null
    const size = weightUnits.value.find((u) => u.key === weightUnitKey.value)?.size ?? 1
    weightAmount.value = grams === null || grams === undefined ? null : roundGrams(grams / size)
  },
  { immediate: true },
)

/** Switching unit keeps the same weight, it doesn't reinterpret the number. */
function changeWeightUnit(nextKey: string) {
  const from = weightUnits.value.find((u) => u.key === weightUnitKey.value)?.size ?? 1
  const to = weightUnits.value.find((u) => u.key === nextKey)?.size ?? 1
  if (weightAmount.value !== null) {
    weightAmount.value = Math.round(((weightAmount.value * from) / to) * 100) / 100
  }
  weightUnitKey.value = nextKey
}

function saveWeight() {
  const size = weightUnits.value.find((u) => u.key === weightUnitKey.value)?.size ?? 1
  const amount = weightAmount.value
  // Clearing the box is meaningful: it says "I don't know what this weighs",
  // which is what takes gram portions back off the picker.
  const grams = amount === null || !Number.isFinite(amount) || amount <= 0 ? null : amount * size
  const current = (recipe.value?.recipe_final_weight_g ?? null) as number | null
  if (grams === null && current === null) return
  if (grams !== null && current !== null && Math.abs(grams - current) < 0.001) return
  patch({ final_weight_g: grams })
}

// --- ingredients ------------------------------------------------------------

/**
 * Pick a *different* food for this ingredient.
 *
 * The same search the importer's unmatched rows use, so "it guessed wrong" and
 * "it couldn't guess" land in one place. Whatever gets picked replaces the food
 * on this row rather than being appended as a new ingredient — see the
 * `ingredient` parameter in `app/utils/foodLink.ts`.
 */
function changeLink(ingredient: RecipeIngredient) {
  const params = new URLSearchParams({
    recipe: String(id.value),
    ingredient: String(ingredient.id),
    q: ingredientSearchTerm(ingredient),
  })

  // The amount rides along so swapping the food keeps it. Changing "Avocado Oil
  // Cooking Spray" to "Avocado Oil" is a correction to *what* it is, not to how
  // much of it there is, and making the user re-enter 0.25 cup would say
  // otherwise. Carried through /add to the portion picker.
  if (ingredient.grams > 0) params.set('g', String(ingredient.grams))
  if (ingredient.serving_label) params.set('sl', ingredient.serving_label)
  if (ingredient.serving_count) params.set('sc', String(ingredient.serving_count))
  return `/add?${params}`
}

/**
 * Where tapping an ingredient's name goes.
 *
 * A matched one re-opens the portion picker on the food, landing on the portion
 * it was added with — the common case is "how much of this again?", not "this
 * is the wrong food", which is what the Change button beside it is for. An
 * unmatched row has no food to open, so its name goes straight to the search.
 */
function editLink(ingredient: RecipeIngredient) {
  if (!ingredient.food) return changeLink(ingredient)

  const params = new URLSearchParams({
    recipe: String(id.value),
    ingredient: String(ingredient.id),
    g: String(ingredient.grams),
  })
  if (ingredient.serving_label) params.set('sl', ingredient.serving_label)
  if (ingredient.serving_count) params.set('sc', String(ingredient.serving_count))
  // So the Optional switch over there opens in the state it is in over here.
  if (ingredient.is_optional) params.set('opt', '1')
  return `/food/${ingredient.food.id}?${params}`
}

/**
 * Switch an optional ingredient on or off for the recipe itself.
 *
 * A different act from skipping it once while logging a meal, which leaves the
 * recipe alone — and from deleting it, which forgets the suggestion entirely.
 */
async function setIncluded(ingredientId: number, included: boolean) {
  saving.value = true
  saveError.value = null
  try {
    await $fetch(`/api/recipes/${id.value}/ingredients/${ingredientId}`, {
      method: 'PATCH',
      body: { is_included: included },
    })
    await refresh()
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save'
  } finally {
    saving.value = false
  }
}

// --- inline amount edit -------------------------------------------------

/** This ingredient's own unit, if it's stored as a named serving rather than a bare weight. */
const unitOf = (ingredient: RecipeIngredient) =>
  ingredient.serving_label && ingredient.serving_count
    ? { label: ingredient.serving_label, size: ingredient.grams / ingredient.serving_count }
    : null

/** The unit this row is in right now, before any switch. */
function baseChoice(ingredient: RecipeIngredient): PortionUnit {
  const own = unitOf(ingredient)
  if (own) return { key: 'own', label: own.label, size: own.size }
  const base = baseUnit(!!ingredient.food?.is_liquid)
  return { key: base, label: base, size: 1 }
}

/** Every unit this row's amount can be switched to, same table the meal-time
 *  adjuster offers: its own unit first, then the usual weight/volume units. */
function unitChoices(ingredient: RecipeIngredient): PortionUnit[] {
  const own = unitOf(ingredient)
  const isLiquidFood = !!ingredient.food?.is_liquid
  const list: PortionUnit[] = own ? [{ key: 'own', label: own.label, size: own.size }] : []
  for (const choice of portionUnits(isLiquidFood)) {
    if (own && choice.label.toLowerCase() === own.label.toLowerCase()) continue
    list.push(choice)
  }
  if (!isLiquidFood && !(own && own.label.toLowerCase().includes('cup'))) {
    const cup = VOLUME_UNITS.find((u) => u.key === 'cup')!
    list.push({ key: 'u:cup', label: cup.label, size: cup.size })
  }
  return list
}

function displayAmount(ingredient: RecipeIngredient, choice: PortionUnit): number {
  if (choice.key === 'g' || choice.key === 'ml') return roundGrams(ingredient.grams)
  return Math.round((ingredient.grams / choice.size) * 100) / 100
}

/** Which row's amount is open for a quick edit, and its unsaved draft. */
const editingIngredientId = ref<number | null>(null)
const amountDraft = ref(0)
const unitDraft = ref<PortionUnit>({ key: 'g', label: 'g', size: 1 })
const amountInputEl = ref<HTMLInputElement | null>(null)
function setAmountInputEl(el: Element | null) {
  amountInputEl.value = el as HTMLInputElement | null
}

watch(editingIngredientId, async (opened) => {
  if (opened === null) return
  await nextTick()
  amountInputEl.value?.focus()
  amountInputEl.value?.select()
})

function startEditAmount(ingredient: RecipeIngredient) {
  const choice = baseChoice(ingredient)
  editingIngredientId.value = ingredient.id
  unitDraft.value = choice
  amountDraft.value = displayAmount(ingredient, choice)
}

/** Switching units mid-edit keeps the weight fixed — it just re-expresses it —
 *  rather than keeping the number in the box and quietly changing the weight. */
function switchDraftUnit(unit: PortionUnit) {
  const grams = amountDraft.value * unitDraft.value.size
  unitDraft.value = unit
  amountDraft.value = Math.round((grams / unit.size) * 100) / 100
}

function cancelEditAmount() {
  editingIngredientId.value = null
}

/**
 * Closes the editor and, if anything actually changed, saves it.
 *
 * Bound to the group's `focusout`, not each control's `blur`: moving focus
 * from the amount box to the unit picker is still *inside* this edit, and
 * closing it mid-click there would throw the unit change away.
 */
function onAmountGroupFocusOut(event: FocusEvent, ingredient: RecipeIngredient) {
  const next = event.relatedTarget as Node | null
  const group = event.currentTarget as HTMLElement
  if (next && group.contains(next)) return
  commitAmount(ingredient)
}

async function commitAmount(ingredient: RecipeIngredient) {
  if (editingIngredientId.value !== ingredient.id) return
  editingIngredientId.value = null

  const isBaseUnit = unitDraft.value.key === 'g' || unitDraft.value.key === 'ml'
  const grams = amountDraft.value * unitDraft.value.size
  const servingLabel = isBaseUnit ? null : unitDraft.value.label
  const servingCount = isBaseUnit ? null : amountDraft.value

  const unchanged = Math.abs(grams - ingredient.grams) < 0.0001
    && servingLabel === (ingredient.serving_label ?? null)
    && servingCount === (ingredient.serving_count ?? null)
  if (unchanged) return

  saving.value = true
  saveError.value = null
  try {
    await $fetch(`/api/recipes/${id.value}/ingredients/${ingredient.id}`, {
      method: 'PATCH',
      body: { grams, serving_label: servingLabel, serving_count: servingCount },
    })
    await refresh()
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save'
  } finally {
    saving.value = false
  }
}

// --- order ------------------------------------------------------------------

/**
 * A local, reorderable copy of the ingredient list.
 *
 * The drag has to move rows *now*, under the finger, so the list it reorders
 * can't be the fetch result. Re-seeded from the server whenever that changes,
 * which is also how a rejected reorder puts itself back.
 */
const rows = ref<RecipeIngredient[]>([])
watch(
  () => data.value?.ingredients,
  (list) => { rows.value = [...(list ?? [])] },
  { immediate: true },
)

async function saveOrder(ordered: RecipeIngredient[]) {
  saving.value = true
  saveError.value = null
  try {
    await $fetch(`/api/recipes/${id.value}/ingredient-order`, {
      method: 'PATCH',
      // The whole list every time: the route refuses a partial one rather than
      // scrambling the rows it wasn't told about.
      body: { ids: ordered.map((row) => row.id) },
    })
    await refresh()
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not reorder'
    await refresh()
  } finally {
    saving.value = false
  }
}

const { dragging, container, onPointerDown, nudge } = useDragSort(rows, saveOrder)

/** Nothing to reorder with one ingredient, so no handle to explain. */
const canReorder = computed(() => rows.value.length > 1)

async function removeIngredient(ingredientId: number) {
  saving.value = true
  try {
    await $fetch(`/api/recipes/${id.value}/ingredients/${ingredientId}`, { method: 'DELETE' })
    await refresh()
  } finally {
    saving.value = false
  }
}

// --- variants ---------------------------------------------------------------

/**
 * The other ways this recipe gets made.
 *
 * A flat family, so every variant can reach every other one — which is the point
 * of them being linked at all. The one you're on is shown alongside, unlinked, so
 * the strip reads as "here is where you are among these".
 */
const variants = computed(() => data.value?.variants ?? [])

const namingVariant = ref(false)
const variantName = ref('')
const savingVariant = ref(false)

function startVariant() {
  namingVariant.value = true
  variantName.value = ''
}

/**
 * Copy this recipe into its own family and open the copy.
 *
 * No adjustments: from here a variant starts as a duplicate you then edit. The
 * log screen has the other version of this button, where the changes you just
 * made for one meal are what gets kept.
 */
async function saveVariant() {
  if (savingVariant.value) return
  savingVariant.value = true
  saveError.value = null
  try {
    const { id: newId } = await $fetch<{ id: number }>(`/api/recipes/${id.value}/variants`, {
      method: 'POST',
      body: { name: variantName.value.trim() || undefined },
    })
    await router.push(`/recipes/${newId}`)
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save'
    savingVariant.value = false
  }
}

// --- totals -----------------------------------------------------------------

const view = ref<'serving' | 'whole'>('serving')
const totals = computed(() =>
  view.value === 'serving' ? (data.value?.per_serving ?? {}) : (data.value?.totals ?? {}),
)

const servingGrams = computed(() => (recipe.value?.serving_grams ?? null) as number | null)

// --- sharing ----------------------------------------------------------------

/**
 * A public link, independent of the Friends list: the common case for "send
 * someone a recipe" is someone who doesn't use Fittown at all.
 *
 * The URL is composed in the browser from the address bar. Deriving a public
 * URL from request headers is guesswork behind a reverse proxy — the same
 * guesswork that broke Google sign-in once already (AGENTS.md §6).
 */
const origin = ref('')
onMounted(() => {
  origin.value = window.location.origin
})

const shareToken = computed(() => data.value?.share?.token ?? null)
const shareLink = computed(() =>
  shareToken.value ? sharedRecipeUrl(origin.value, shareToken.value) : '',
)

const sharing = ref(false)
const shareCopied = ref(false)

async function startSharing() {
  sharing.value = true
  saveError.value = null
  try {
    await $fetch(`/api/recipes/${id.value}/share`, { method: 'POST' })
    await refresh()
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not share'
  } finally {
    sharing.value = false
  }
}

async function stopSharing() {
  sharing.value = true
  try {
    await $fetch(`/api/recipes/${id.value}/share`, { method: 'DELETE' })
    await refresh()
  } finally {
    sharing.value = false
  }
}

async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(shareLink.value)
    shareCopied.value = true
    setTimeout(() => (shareCopied.value = false), 2000)
  } catch {
    // Refused on insecure origins and in some in-app browsers; the link is on
    // screen in a selectable field regardless.
    saveError.value = 'Couldn’t copy automatically — select the link and copy it.'
  }
}

// --- delete -----------------------------------------------------------------

const confirmDelete = ref(false)

async function remove() {
  saving.value = true
  saveError.value = null
  try {
    await $fetch(`/api/recipes/${id.value}`, { method: 'DELETE' })
    await router.push('/recipes')
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not delete'
    confirmDelete.value = false
    saving.value = false
  }
}

const logLink = computed(
  () => `/food/${id.value}?meal=dinner${diaryDay.value ? `&d=${diaryDay.value}` : ''}`,
)
</script>

<template>
  <div v-if="error" class="alert alert-error">
    <span>Recipe not found.</span>
  </div>

  <div v-else-if="recipe" class="flex flex-col gap-3">
    <header class="flex items-center gap-2">
      <button class="btn btn-ghost btn-sm btn-square" aria-label="Back" @click="router.back()">
        <AppIcon name="chevronLeft" class="w-5 h-5" />
      </button>
      <h1 class="font-semibold flex-1 truncate">{{ recipe.name }}</h1>
      <span v-if="saving" class="loading loading-spinner loading-sm" />
    </header>

    <!-- The family. Always present, because "make another way of doing this" is
         as much a part of a recipe as its ingredients — and when there are
         siblings, this is the only way to walk between them. -->
    <section class="flex flex-wrap items-center gap-1.5">
      <template v-if="variants.length">
        <span class="badge badge-sm badge-neutral">{{ recipe.name }}</span>
        <NuxtLink
          v-for="variant in variants"
          :key="variant.id"
          :to="`/recipes/${variant.id}`"
          class="badge badge-sm badge-outline hover:badge-neutral transition-colors"
          :title="variant.kcal_per_serving !== null
            ? `${Math.round(variant.kcal_per_serving)} kcal per serving`
            : 'Nothing in it yet'"
        >
          {{ variant.name }}
        </NuxtLink>
      </template>

      <button
        v-if="!namingVariant"
        class="btn btn-ghost btn-xs gap-1 text-primary"
        @click="startVariant"
      >
        <AppIcon name="plus" class="w-3.5 h-3.5" />
        {{ variants.length ? 'Another variant' : 'Save as a variant' }}
      </button>

      <div v-else class="flex gap-2 w-full">
        <input
          v-model="variantName"
          type="text"
          class="input input-bordered input-sm flex-1 min-w-0"
          :placeholder="`${recipe.name} (my way)`"
          aria-label="Name for the variant"
          @keyup.enter="saveVariant"
        >
        <button class="btn btn-sm gap-2" :disabled="savingVariant" @click="saveVariant">
          <span v-if="savingVariant" class="loading loading-spinner loading-xs" />
          Create
        </button>
        <button class="btn btn-ghost btn-sm" @click="namingVariant = false">Cancel</button>
      </div>
    </section>

    <!-- What it is -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <label class="form-control">
          <span class="label-text text-xs mb-1">Name</span>
          <input
            v-model="name"
            type="text"
            class="input input-bordered w-full"
            @blur="saveName"
            @keyup.enter="saveName"
          >
        </label>

        <div class="flex gap-2">
          <label class="form-control w-28">
            <span class="label-text text-xs mb-1">Servings</span>
            <input
              v-model.number="servingsInput"
              type="number"
              min="0"
              step="any"
              inputmode="decimal"
              class="input input-bordered w-full"
              @blur="saveServings"
              @keyup.enter="saveServings"
            >
          </label>

          <label class="form-control flex-1">
            <span class="label-text text-xs mb-1">Final weight (optional)</span>
            <div class="flex gap-2">
              <input
                v-model.number="weightAmount"
                type="number"
                min="0"
                step="any"
                inputmode="decimal"
                class="input input-bordered flex-1 min-w-0"
                :placeholder="`Weigh it in ${unit}`"
                @blur="saveWeight"
                @keyup.enter="saveWeight"
              >
              <select
                class="select select-bordered w-24"
                :value="weightUnitKey"
                @change="changeWeightUnit(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="u in weightUnits" :key="u.key" :value="u.key">{{ u.label }}</option>
              </select>
            </div>
          </label>
        </div>

        <label class="label cursor-pointer justify-start gap-3 py-0">
          <input
            type="checkbox"
            class="toggle toggle-sm"
            :checked="isLiquid"
            @change="patch({ is_liquid: ($event.target as HTMLInputElement).checked })"
          >
          <span class="label-text text-sm">Measured by volume (a drink or soup)</span>
        </label>

        <p v-if="!showsGrams" class="text-xs text-base-content/60">
          Without a final weight this recipe is logged in servings only. Weigh the
          finished dish to log it in {{ unit }} too — cooking changes what it weighs,
          so the ingredients can’t answer that.
        </p>
        <p v-else-if="servingGrams" class="text-xs text-base-content/60 tabular">
          One serving is {{ roundGrams(servingGrams) }} {{ unit }}.
        </p>

        <p v-if="saveError" class="text-xs text-error">{{ saveError }}</p>
      </div>
    </section>

    <!-- Ingredients -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-0">
        <header class="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 class="font-semibold">Ingredients</h2>
          <span class="text-sm text-base-content/60 tabular">
            {{ roundGrams(data?.raw_g ?? 0) }} {{ unit }} in
          </span>
        </header>

        <ul v-if="rows.length" ref="container" class="divide-y divide-base-200">
          <li
            v-for="(ingredient, index) in rows"
            :key="ingredient.id"
            data-sort-row
            class="flex items-center gap-2 px-4 py-2.5 transition-colors"
            :class="{ 'bg-base-200': dragging === index }"
          >
            <!-- `touch-action: none` is on the handle and nowhere else: on the
                 row or the list it would kill the page scroll. Focusable and
                 arrow-key operable, so this isn't drag-only.
                 Only `pointerdown` is bound here — the rest of the drag is
                 listened for on the window, because a release that misses this
                 button used to leave the row stuck to the pointer. -->
            <button
              v-if="canReorder"
              class="btn btn-ghost btn-xs btn-square text-base-content/30 hover:text-base-content/60 shrink-0 touch-none cursor-grab"
              :aria-label="`Reorder ${ingredientName(ingredient)}`"
              title="Drag to reorder"
              @pointerdown="onPointerDown($event, index)"
              @keydown.up.prevent="nudge(index, -1)"
              @keydown.down.prevent="nudge(index, 1)"
            >
              <AppIcon name="grip" class="w-4 h-4" />
            </button>
            <!-- Only on optional rows, so the common case keeps its layout and
                 nothing shifts sideways on a recipe that has none. -->
            <input
              v-if="ingredient.is_optional"
              type="checkbox"
              class="checkbox checkbox-sm shrink-0"
              :checked="!!ingredient.is_included"
              :aria-label="`Include ${ingredientName(ingredient)}`"
              @change="setIncluded(ingredient.id, ($event.target as HTMLInputElement).checked)"
            >

            <div class="flex-1 min-w-0" :class="{ 'opacity-50': ingredient.is_optional && !ingredient.is_included }">
              <!-- The badge sits outside the truncating link on purpose:
                   inside it, a long recipe name clips the badge away entirely,
                   which is exactly when it is most needed. -->
              <div class="flex items-center gap-1.5 min-w-0">
                <NuxtLink
                  :to="editLink(ingredient)"
                  class="truncate font-medium text-sm hover:underline"
                  :class="{ 'text-base-content/60 italic': !isResolved(ingredient) }"
                >
                  {{ ingredientName(ingredient) }}
                </NuxtLink>
                <span
                  v-if="isNestedRecipe(ingredient)"
                  class="badge badge-xs badge-primary shrink-0"
                >recipe</span>
                <span
                  v-if="ingredient.is_optional"
                  class="badge badge-xs badge-ghost shrink-0"
                >optional</span>
              </div>
              <div
                v-if="editingIngredientId === ingredient.id"
                class="flex items-center gap-1.5 flex-wrap"
                @focusout="onAmountGroupFocusOut($event, ingredient)"
              >
                <input
                  :ref="setAmountInputEl"
                  v-model.number="amountDraft"
                  type="number"
                  min="0"
                  step="any"
                  inputmode="decimal"
                  class="input input-bordered input-xs w-20 text-right tabular"
                  :aria-label="`Amount of ${ingredientName(ingredient)}`"
                  @keydown.enter="commitAmount(ingredient)"
                  @keydown.esc="cancelEditAmount"
                >
                <select
                  class="select select-bordered select-xs w-24 truncate"
                  :aria-label="`Unit for ${ingredientName(ingredient)}`"
                  :value="unitDraft.key"
                  @change="switchDraftUnit(unitChoices(ingredient).find((u) => u.key === ($event.target as HTMLSelectElement).value)!)"
                  @keydown.enter="commitAmount(ingredient)"
                  @keydown.esc="cancelEditAmount"
                >
                  <option v-for="choice in unitChoices(ingredient)" :key="choice.key" :value="choice.key">
                    {{ choice.label }}
                  </option>
                </select>
              </div>
              <button
                v-else-if="isResolved(ingredient)"
                type="button"
                class="block text-xs truncate tabular text-base-content/60 rounded hover:bg-base-200 -mx-1 px-1"
                @click="startEditAmount(ingredient)"
              >
                {{ ingredientDetail(ingredient) || 'no amount given' }}
              </button>
              <div v-else class="text-xs truncate tabular text-warning">
                Tap to pick a food{{ ingredient.note ? ` · ${ingredient.note}` : '' }}
              </div>
            </div>

            <!-- A dash rather than 0: we don't know what this is, which is not
                 the same as knowing it has no calories. -->
            <!-- A switched-off optional shows what it *would* add, prefixed,
                 rather than a bare number that reads as part of the total. -->
            <div
              v-if="editingIngredientId !== ingredient.id"
              class="text-sm tabular shrink-0"
              :class="{
                'text-base-content/30': !isResolved(ingredient),
                'text-base-content/50': ingredient.is_optional && !ingredient.is_included,
              }"
            >
              <template v-if="!isResolved(ingredient)">—</template>
              <template v-else-if="ingredient.is_optional && !ingredient.is_included">
                +{{ Math.round(ingredient.nutrients.kcal ?? 0) }}
              </template>
              <template v-else>{{ Math.round(ingredient.nutrients.kcal ?? 0) }}</template>
            </div>

            <!-- A nested recipe is a place you can go, not just an amount to
                 change: half of what is in this dish is in there. Hidden while
                 this row's amount is being edited so the picker has the room. -->
            <NuxtLink
              v-if="isNestedRecipe(ingredient) && editingIngredientId !== ingredient.id"
              :to="`/recipes/${ingredient.food!.id}`"
              class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-primary"
              :aria-label="`Open ${ingredientName(ingredient)}`"
              title="Open this recipe"
            >
              <AppIcon name="chevronRight" class="w-4 h-4" />
            </NuxtLink>

            <!-- Only for rows that already have a food. An unmatched row's own
                 name is the link to the same search, so a second one beside it
                 would be two controls doing one job. Hidden mid-edit for the
                 same reason as the recipe link above. -->
            <NuxtLink
              v-if="isResolved(ingredient) && editingIngredientId !== ingredient.id"
              :to="changeLink(ingredient)"
              class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-primary"
              :aria-label="`Change ${ingredientName(ingredient)} to a different food`"
              title="Pick a different food"
            >
              <AppIcon name="swap" class="w-4 h-4" />
            </NuxtLink>

            <button
              v-if="editingIngredientId !== ingredient.id"
              class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
              :aria-label="`Remove ${ingredientName(ingredient)}`"
              @click="removeIngredient(ingredient.id)"
            >
              <AppIcon name="trash" class="w-4 h-4" />
            </button>
          </li>
        </ul>

        <p v-else class="px-4 pb-1 text-sm text-base-content/40">Nothing in it yet.</p>

        <NuxtLink
          :to="`/add?recipe=${id}`"
          class="btn btn-ghost btn-sm justify-start gap-2 m-2 mt-1 text-primary"
        >
          <AppIcon name="plus" class="w-4 h-4" />
          Add ingredient
        </NuxtLink>
      </div>
    </section>

    <!-- How to make it -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-2">
        <h2 class="font-semibold">Instructions</h2>
        <textarea
          v-model="instructions"
          class="textarea textarea-bordered w-full min-h-32 text-sm leading-relaxed"
          :maxlength="MAX_INSTRUCTIONS_CHARS"
          placeholder="Whisk the vinegar, honey and mustard together, then drizzle in the oil."
          @blur="saveInstructions"
        />
        <p class="text-xs text-base-content/50">
          Just for you to read while cooking — nothing here affects the nutrition.
        </p>
      </div>
    </section>

    <div class="flex gap-2">
      <button
        v-if="!confirmDelete"
        class="btn btn-outline btn-error"
        :disabled="saving"
        aria-label="Delete recipe"
        @click="confirmDelete = true"
      >
        <AppIcon name="trash" class="w-4 h-4" />
      </button>
      <button
        v-else
        class="btn btn-error gap-2"
        :disabled="saving"
        @click="remove"
      >
        <AppIcon name="trash" class="w-4 h-4" />
        Delete for good
      </button>

      <NuxtLink
        v-if="servingGrams"
        :to="logLink"
        class="btn btn-primary flex-1 gap-2"
      >
        <AppIcon name="plus" class="w-4 h-4" />
        Log this
      </NuxtLink>
    </div>

    <!-- Share it ----------------------------------------------------------->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-2">
        <div class="flex items-center gap-2">
          <div class="flex-1 min-w-0">
            <h2 class="font-semibold text-sm">Share this recipe</h2>
            <p class="text-xs text-base-content/50">
              A link anyone can open — no Fittown account needed.
            </p>
          </div>
          <button
            v-if="!shareToken"
            class="btn btn-outline btn-sm gap-2"
            :disabled="sharing"
            @click="startSharing"
          >
            <AppIcon name="link" class="w-4 h-4" />
            Create link
          </button>
        </div>

        <template v-if="shareToken">
          <div class="flex gap-2">
            <input
              class="input input-bordered input-sm flex-1 min-w-0 text-xs"
              :value="shareLink"
              readonly
              aria-label="Public link to this recipe"
              @focus="($event.target as HTMLInputElement).select()"
            >
            <button class="btn btn-sm" @click="copyShareLink">
              {{ shareCopied ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <button
            class="btn btn-ghost btn-xs self-start text-base-content/60"
            :disabled="sharing"
            @click="stopSharing"
          >
            Stop sharing
          </button>
          <p class="text-xs text-base-content/50">
            Whoever opens it sees this recipe as it is now, and can copy it into
            their own. Stopping breaks the link; copies already taken stay theirs.
          </p>
        </template>
      </div>
    </section>

    <!-- What it comes to -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="font-semibold">Nutrition</h2>
          <span class="text-2xl font-semibold tabular">
            {{ Math.round(totals.kcal ?? 0) }}
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

        <NutrientBreakdown :totals="totals" />

        <p class="text-xs text-base-content/50">
          Meals you have already logged keep the version you logged them with —
          editing this recipe only changes what you log from here on.
        </p>
      </div>
    </section>
  </div>
</template>

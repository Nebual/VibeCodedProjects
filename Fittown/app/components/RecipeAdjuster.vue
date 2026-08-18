<script setup lang="ts">
import { baseUnit, portionUnits, roundGrams, VOLUME_UNITS, type PortionUnit } from '#shared/portions'
import { shortFoodName, type RecipeAdjustment } from '#shared/recipes'
import type { FoodRow } from '~/composables/useDiary'
import type { RecipeIngredient } from '~/composables/useRecipes'
import { ingredientName, isNestedRecipe } from '~/utils/ingredients'

/**
 * "Three eggs today, and no bacon."
 *
 * Changes a recipe for **one meal**. Nothing here touches the recipe — the
 * adjustments ride along with the log and land on the frozen copy the diary
 * entry points at, which is the whole reason a one-off is possible at all.
 *
 * Amounts start in the unit the row already uses: a row added as "4 × egg"
 * is edited in eggs, because that is the change somebody actually makes. Grams
 * are derived from the per-unit size the row was stored with, so 3 eggs is
 * exactly three quarters of what four came to. The unit itself can also be
 * switched (egg → g, cup → oz, …); switching keeps the weight fixed and just
 * re-expresses it, the same conversion the diary's portion picker uses.
 */
const props = defineProps<{
  ingredients: RecipeIngredient[]
  /** Muted, and no switches: a meal already logged that we're only showing. */
  readonly?: boolean
}>()

const emit = defineEmits<{ 'update:adjustments': [adjustments: RecipeAdjustment[]] }>()

/** Per-row edits, keyed by ingredient id. Absent means untouched. */
interface Edit {
  amount?: number
  unit?: PortionUnit
  included?: boolean
  food?: FoodRow
}
const edits = ref(new Map<number, Edit>())
/** Foods added to this meal that the recipe never had. */
const extras = ref<{ food: FoodRow; grams: number }[]>([])

// Re-seeded whenever the recipe underneath changes, so a fetch landing late
// doesn't leave edits pointing at rows that are no longer there.
watch(
  () => props.ingredients,
  () => {
    edits.value = new Map()
    extras.value = []
  },
)

/** Is this row measured in something other than grams? */
const unitOf = (ingredient: RecipeIngredient) =>
  ingredient.serving_label && ingredient.serving_count
    ? { label: ingredient.serving_label, size: ingredient.grams / ingredient.serving_count }
    : null

/** The unit this row is in right now: whatever it's stored as, until switched. */
function baseChoice(ingredient: RecipeIngredient): PortionUnit {
  const own = unitOf(ingredient)
  if (own) return { key: 'own', label: own.label, size: own.size }
  const unit = baseUnit(!!ingredient.food?.is_liquid)
  return { key: unit, label: unit, size: 1 }
}

/** Every unit this row can be switched to: its own unit first, then the same
 *  weight/volume units the diary's portion picker offers. */
function unitChoices(ingredient: RecipeIngredient): PortionUnit[] {
  const own = unitOf(ingredient)
  const isLiquid = !!ingredient.food?.is_liquid
  const list: PortionUnit[] = own ? [{ key: 'own', label: own.label, size: own.size }] : []
  for (const unit of portionUnits(isLiquid)) {
    if (own && unit.label.toLowerCase() === own.label.toLowerCase()) continue
    list.push(unit)
  }
  // Solids don't come with a cup of their own, but a cup is still how most
  // people measure by hand — same estimate the diary's picker falls back to.
  if (!isLiquid && !(own && own.label.toLowerCase().includes('cup'))) {
    const cup = VOLUME_UNITS.find((unit) => unit.key === 'cup')!
    list.push({ key: 'u:cup', label: cup.label, size: cup.size })
  }
  return list
}

const activeUnit = (ingredient: RecipeIngredient): PortionUnit =>
  edits.value.get(ingredient.id)?.unit ?? baseChoice(ingredient)

/** What the amount box shows: a count of servings, or a weight. */
function currentAmount(ingredient: RecipeIngredient): number {
  const edit = edits.value.get(ingredient.id)
  if (edit?.amount !== undefined) return edit.amount
  const unit = activeUnit(ingredient)
  if (unit.key === 'g' || unit.key === 'ml') return roundGrams(ingredient.grams)
  return Math.round((ingredient.grams / unit.size) * 100) / 100
}

const amountUnit = (ingredient: RecipeIngredient) => activeUnit(ingredient).label

/** Switching units keeps the underlying amount the same — 3 eggs and 150 g are
 *  the same weight, just expressed differently — not the number in the box. */
function changeUnit(ingredient: RecipeIngredient, unit: PortionUnit) {
  const grams = currentAmount(ingredient) * activeUnit(ingredient).size
  edit(ingredient.id, { unit, amount: Math.round((grams / unit.size) * 100) / 100 })
}

/**
 * The up/down buttons next to the amount box, drawn by hand rather than left
 * as the browser's own: Firefox's native spinner can't be repositioned or
 * resized by author CSS at all (it's opaque UA chrome, not a styleable
 * pseudo-element the way Chrome's is), which is what made it look off to begin
 * with. A step of 1 matches what the native control already did here.
 */
function bump(ingredient: RecipeIngredient, delta: number) {
  edit(ingredient.id, { amount: Math.max(0, currentAmount(ingredient) + delta) })
}

const isIncluded = (ingredient: RecipeIngredient) => {
  const edit = edits.value.get(ingredient.id)
  if (edit?.included !== undefined) return edit.included
  // An optional the recipe leaves out starts out left out here too.
  return !ingredient.is_optional || !!ingredient.is_included
}

const foodOf = (ingredient: RecipeIngredient) =>
  edits.value.get(ingredient.id)?.food ?? ingredient.food

function edit(id: number, change: Edit) {
  const next = new Map(edits.value)
  next.set(id, { ...next.get(id), ...change })
  edits.value = next
}

// --- what all that comes to -------------------------------------------------

/**
 * The adjustments, as the API takes them.
 *
 * Only genuine differences are emitted. A row the user opened, fiddled with and
 * put back should produce nothing, or the meal gets a note about a change that
 * didn't happen.
 */
const adjustments = computed<RecipeAdjustment[]>(() => {
  const out: RecipeAdjustment[] = []

  for (const ingredient of props.ingredients) {
    const change = edits.value.get(ingredient.id)
    if (!change) continue

    const unit = change.unit ?? baseChoice(ingredient)
    const isBaseUnit = unit.key === 'g' || unit.key === 'ml'
    const included = isIncluded(ingredient)
    const wasIncluded = !ingredient.is_optional || !!ingredient.is_included

    const amount = change.amount
    const grams = amount === undefined ? undefined : amount * unit.size

    const movedAmount = grams !== undefined && Math.abs(grams - ingredient.grams) > 0.0001
    const swapped = change.food !== undefined && change.food.id !== ingredient.food?.id
    const skipped = included !== wasIncluded

    if (!movedAmount && !swapped && !skipped) continue

    out.push({
      op: 'set',
      ingredient_id: ingredient.id,
      ...(movedAmount
        ? {
          grams,
          // The label rides along so the frozen copy still reads "3 × egg"
          // rather than "150 g", the same way any other portion does.
          serving_label: isBaseUnit ? null : unit.label,
          serving_count: isBaseUnit ? null : amount,
        }
        : {}),
      ...(swapped ? { food_id: change.food!.id } : {}),
      ...(skipped ? { included } : {}),
    })
  }

  for (const extra of extras.value) {
    out.push({ op: 'add', food_id: extra.food.id, grams: extra.grams })
  }

  return out
})

watch(adjustments, (value) => emit('update:adjustments', value), { immediate: true, deep: true })

const changed = computed(() => adjustments.value.length > 0)

function reset() {
  edits.value = new Map()
  extras.value = []
}

// --- picking a food ---------------------------------------------------------

/** Which row a swap is for, or 'add' when it's a new line. */
const picking = ref<number | 'add' | null>(null)

const dialogTitle = computed(() =>
  picking.value === 'add' ? 'Add to this meal' : 'Swap for another food',
)

function onPicked(food: FoodRow, grams: number) {
  if (picking.value === 'add') extras.value = [...extras.value, { food, grams }]
  else if (typeof picking.value === 'number') edit(picking.value, { food })
  picking.value = null
}

function removeExtra(index: number) {
  extras.value = extras.value.filter((_, i) => i !== index)
}

function bumpExtra(index: number, delta: number) {
  extras.value[index]!.grams = Math.max(0, extras.value[index]!.grams + delta)
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <ul class="flex flex-col divide-y divide-base-200 -mx-4">
      <li
        v-for="ingredient in ingredients"
        :key="ingredient.id"
        class="flex items-center gap-2 px-4 py-2"
        :class="{ 'opacity-45': !isIncluded(ingredient) }"
      >
        <input
          v-if="!readonly"
          type="checkbox"
          class="checkbox checkbox-sm shrink-0"
          :checked="isIncluded(ingredient)"
          :aria-label="`Include ${ingredientName(ingredient)}`"
          @change="edit(ingredient.id, { included: ($event.target as HTMLInputElement).checked })"
        >

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <!-- Shortened here, unlike in the recipe editor: this is a row of
                 controls, and "Chicken, broiler or fryers, bre…" leaves no room
                 for the amount box that is the whole point of it. -->
            <span class="truncate text-sm font-medium">
              {{ shortFoodName(String(foodOf(ingredient)?.name ?? ingredientName(ingredient)), 28) }}
            </span>
            <span
              v-if="isNestedRecipe(ingredient)"
              class="badge badge-xs badge-primary shrink-0"
            >recipe</span>
            <span
              v-if="ingredient.is_optional"
              class="badge badge-xs badge-ghost shrink-0"
            >optional</span>
          </div>
          <div v-if="!isIncluded(ingredient)" class="text-xs text-base-content/60">
            Left out of this meal
          </div>
        </div>

        <div v-if="isIncluded(ingredient) && !readonly" class="flex items-center gap-1.5 shrink-0">
          <div class="relative">
            <input
              :value="currentAmount(ingredient)"
              type="number"
              min="0"
              step="any"
              inputmode="decimal"
              class="input input-bordered input-sm w-20 text-right tabular pr-4 no-native-spinner"
              :aria-label="`Amount of ${ingredientName(ingredient)}`"
              @input="edit(ingredient.id, { amount: Number(($event.target as HTMLInputElement).value) })"
            >
            <div class="amount-stepper">
              <button
                type="button"
                :aria-label="`Increase amount of ${ingredientName(ingredient)}`"
                @click="bump(ingredient, 1)"
              >
                <AppIcon name="chevronUp" class="w-2.5 h-2.5" />
              </button>
              <button
                type="button"
                :aria-label="`Decrease amount of ${ingredientName(ingredient)}`"
                @click="bump(ingredient, -1)"
              >
                <AppIcon name="chevronDown" class="w-2.5 h-2.5" />
              </button>
            </div>
          </div>
          <select
            class="select select-bordered select-sm w-24 truncate shrink-0"
            :aria-label="`Unit for ${ingredientName(ingredient)}`"
            :value="activeUnit(ingredient).key"
            @change="changeUnit(ingredient, unitChoices(ingredient).find((u) => u.key === ($event.target as HTMLSelectElement).value)!)"
          >
            <option v-for="unit in unitChoices(ingredient)" :key="unit.key" :value="unit.key">
              {{ unit.label }}
            </option>
          </select>
          <button
            class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-primary"
            :aria-label="`Swap ${ingredientName(ingredient)} for something else`"
            title="Swap for another food"
            @click="picking = ingredient.id"
          >
            <AppIcon name="swap" class="w-4 h-4" />
          </button>
        </div>
        <div v-else-if="readonly" class="text-sm tabular shrink-0 text-base-content/60">
          {{ currentAmount(ingredient) }} {{ amountUnit(ingredient) }}
        </div>
      </li>

      <li
        v-for="(extra, index) in extras"
        :key="`extra-${index}`"
        class="flex items-center gap-2 px-4 py-2"
      >
        <div class="flex-1 min-w-0">
          <div class="truncate text-sm font-medium">{{ shortFoodName(extra.food.name, 28) }}</div>
          <div class="text-xs text-base-content/60">Just for this meal</div>
        </div>
        <div class="relative shrink-0">
          <input
            v-model.number="extra.grams"
            type="number"
            min="0"
            step="any"
            inputmode="decimal"
            class="input input-bordered input-sm w-20 text-right tabular pr-4 no-native-spinner"
            :aria-label="`Amount of ${extra.food.name}`"
          >
          <div class="amount-stepper">
            <button
              type="button"
              :aria-label="`Increase amount of ${extra.food.name}`"
              @click="bumpExtra(index, 1)"
            >
              <AppIcon name="chevronUp" class="w-2.5 h-2.5" />
            </button>
            <button
              type="button"
              :aria-label="`Decrease amount of ${extra.food.name}`"
              @click="bumpExtra(index, -1)"
            >
              <AppIcon name="chevronDown" class="w-2.5 h-2.5" />
            </button>
          </div>
        </div>
        <span class="text-xs text-base-content/60 shrink-0">
          {{ extra.food.is_liquid ? 'ml' : 'g' }}
        </span>
        <button
          class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
          :aria-label="`Remove ${extra.food.name}`"
          @click="removeExtra(index)"
        >
          <AppIcon name="trash" class="w-4 h-4" />
        </button>
      </li>
    </ul>

    <div v-if="!readonly" class="flex items-center gap-2">
      <button class="btn btn-ghost btn-sm gap-2 text-primary" @click="picking = 'add'">
        <AppIcon name="plus" class="w-4 h-4" />
        Add something
      </button>
      <button
        v-if="changed"
        class="btn btn-ghost btn-sm text-base-content/60 ml-auto"
        @click="reset"
      >
        Reset
      </button>
    </div>

    <IngredientSearchDialog
      :open="picking !== null"
      :title="dialogTitle"
      @close="picking = null"
      @picked="onPicked"
    />
  </div>
</template>

<style scoped>
/*
 * Firefox's number-input spinner is opaque UA chrome — author CSS can't move,
 * resize or restyle it, so "fix its position" isn't actually on the table for
 * the native control. Hiding it and drawing our own is the only way to get
 * something flush against the input's own edges in every browser alike.
 */
.no-native-spinner {
  -moz-appearance: textfield;
}
.no-native-spinner::-webkit-outer-spin-button,
.no-native-spinner::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.amount-stepper {
  position: absolute;
  inset: 1px 1px 1px auto;
  width: 1rem;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 0 calc(var(--radius-field, 0.5rem) - 1px) calc(var(--radius-field, 0.5rem) - 1px) 0;
}
.amount-stepper button {
  flex: 1 1 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in oklab, currentColor 45%, transparent);
}
.amount-stepper button:hover {
  color: currentColor;
  background: color-mix(in oklab, currentColor 8%, transparent);
}
.amount-stepper button:first-child {
  border-bottom: 1px solid color-mix(in oklab, currentColor 15%, transparent);
}
</style>

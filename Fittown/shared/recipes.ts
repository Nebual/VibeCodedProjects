/**
 * Recipe maths, shared by the server, the UI and `scripts/recompute-recipes.mjs`.
 *
 * A recipe is a row in `foods` with `source = 'recipe'`, whose per-100 g
 * nutrient columns are rolled up from its ingredients. Everything in here is
 * pure so all three callers agree on the numbers, and so it can be unit-tested
 * without a database.
 *
 * The relative `./nutrients.ts` import is deliberate: with the extension, this
 * module loads unchanged under Vite, Vitest *and* plain `node` (which strips
 * types but still requires ESM-style explicit extensions), which is what lets
 * the maintenance script import the same formula rather than copy it.
 */

import { NUTRIENT_KEYS } from './nutrients.ts'

/** `source` value that marks a `foods` row as a recipe. */
export const RECIPE_SOURCE = 'recipe'

/**
 * Ceiling on a recipe's ingredient list.
 *
 * A runaway guard, not a rule — no mixture is worth a hundred lines. Lives here
 * rather than in the route that first needed it because the bulk importer has
 * to check the whole paste against it *before* inserting anything, rather than
 * discovering it forty rows in.
 */
export const MAX_INGREDIENTS = 100

/**
 * Ceiling on the instructions text.
 *
 * Generous: an imported recipe arrives carrying its times, its yield, a dozen
 * numbered steps and a source URL, and truncating someone's method mid-sentence
 * is a worse failure than storing a few extra kilobytes.
 */
export const MAX_INSTRUCTIONS_CHARS = 20000

/** The named portion that logs the entire recipe at once. */
export const WHOLE_RECIPE_LABEL = 'whole recipe'

/** A single serving, when that isn't the whole recipe. */
export const SERVING_LABEL = 'serving'

export interface RecipeIngredient {
  /**
   * Resolved amount of this ingredient, in grams (or ml for liquids).
   *
   * Zero is legal: an imported line like "pinch of salt" states no amount, and
   * is stored as 0 g with the descriptor kept as a note for the user to read.
   */
  grams: number
  /**
   * The ingredient's `foods` row — a per-100 g nutrient vector — or **null**
   * when an import could not match the line to a food with confidence.
   */
  food: Record<string, unknown> | null
}

export interface RecipeRollUp {
  /** What went into the mixture. */
  raw_g: number
  /** What the portion maths divides by: the yield if known, else `raw_g`. */
  basis_g: number
  /** Nutrients for the whole recipe. `null` means "not recorded". */
  totals: Record<string, number | null>
  /** The same figures per 100 g/ml of `basis_g` — what `foods` stores. */
  per100: Record<string, number | null>
}

/**
 * What the portion maths divides by.
 *
 * A cooked dish weighs less than its ingredients — water leaves — so the yield
 * wins when the user has weighed it. Without one we fall back to the raw sum,
 * which keeps every *serving* correct (a quarter of the pot is a quarter of the
 * pot however much it weighs) while leaving gram-labelled portions unsafe to
 * show. See `showsGramPortions`.
 */
export function recipeBasisGrams(rawG: number, finalWeightG?: number | null): number {
  // An empty recipe weighs nothing, whatever someone typed in the yield box.
  // Without this, deleting the last ingredient from a recipe with a stated
  // yield leaves it with a serving size and no nutrition — a portion the diary
  // would happily log for zero calories.
  if (!(rawG > 0)) return 0

  return finalWeightG !== null && finalWeightG !== undefined && finalWeightG > 0
    ? finalWeightG
    : rawG
}

/**
 * Roll a list of ingredients up into one nutrient vector.
 *
 * Note that `finalWeightG` never changes `totals` — only how they're spread
 * over 100 g. Stating a cooked weight can't create or destroy nutrition.
 */
export function rollUpRecipe(
  ingredients: RecipeIngredient[],
  finalWeightG?: number | null,
): RecipeRollUp {
  // `i.food` and `i.grams > 0` are both tested here and again in the nutrient
  // loop below, and both tests have to agree: a 0 g pinch of salt or an
  // unmatched "garlic powder" contributes no weight to the mixture, so it
  // must not count toward `rawG` either.
  const counts = (i: RecipeIngredient) => i.food !== null && i.grams > 0
  const rawG = ingredients.reduce((sum, i) => sum + (counts(i) ? i.grams : 0), 0)
  const basisG = recipeBasisGrams(rawG, finalWeightG)

  const totals: Record<string, number | null> = {}
  const per100: Record<string, number | null> = {}

  for (const key of NUTRIENT_KEYS) {
    totals[key] = null
    per100[key] = null
  }

  if (rawG <= 0 || basisG <= 0) return { raw_g: rawG, basis_g: basisG, totals, per100 }

  for (const key of NUTRIENT_KEYS) {
    let sum = 0
    let covered = false

    for (const ingredient of ingredients) {
      if (!counts(ingredient)) continue
      const { grams, food } = ingredient
      const value = food![key]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      sum += (value * grams) / 100
      covered = true
    }

    // `null` means not one ingredient recorded this nutrient — as opposed to a
    // partial sum, which we now show even when most of the recipe's weight
    // didn't declare it. A vegetable-heavy dish with a spoon of butter should
    // show the butter's fat, not hide it because the vegetables don't carry a
    // fat figure at all.
    totals[key] = covered ? sum : null
  }

  // Same fallback custom foods get: people often know the macros when the
  // energy figure is missing, and 4/4/9 is a better answer than "unknown".
  if (totals.kcal === null) {
    const { protein_g: p, carbs_g: c, fat_g: f } = totals
    if (p !== null || c !== null || f !== null) {
      totals.kcal = (p ?? 0) * 4 + (c ?? 0) * 4 + (f ?? 0) * 9
    }
  }

  for (const key of NUTRIENT_KEYS) {
    const total = totals[key]
    per100[key] = total === null ? null : (total / basisG) * 100
  }

  return { raw_g: rawG, basis_g: basisG, totals, per100 }
}

/** Grams in one serving, or null when the recipe has nothing in it yet. */
export function recipeServingGrams(basisG: number, servings: number): number | null {
  if (!(basisG > 0) || !(servings > 0)) return null
  return basisG / servings
}

/**
 * What the food's own serving option is called.
 *
 * A one-serving recipe *is* the whole recipe, and offering both would be two
 * identical options with different names.
 */
export function recipeServingLabel(servings: number): string {
  return servings === 1 ? WHOLE_RECIPE_LABEL : SERVING_LABEL
}

/** Does this recipe need a separate "whole recipe" portion alongside a serving? */
export function needsWholeRecipeOption(servings: number): boolean {
  return servings !== 1
}

/**
 * May the UI offer gram/ounce portions of this food?
 *
 * Only when it knows what the food weighs. For a recipe with no stated yield,
 * the internal basis is the raw ingredient sum, which is the weight that went
 * *into* the pot — offering "100 g of chili" against it would quietly overstate
 * a dish that spent an hour boiling down. Servings stay correct either way, so
 * they are what we offer instead.
 */
export function showsGramPortions(food: {
  source?: unknown
  recipe_final_weight_g?: unknown
}): boolean {
  if (food.source !== RECIPE_SOURCE) return true
  const weight = food.recipe_final_weight_g
  return typeof weight === 'number' && Number.isFinite(weight) && weight > 0
}

/** Is this `foods` row a recipe? */
export function isRecipe(food: { source?: unknown }): boolean {
  return food.source === RECIPE_SOURCE
}

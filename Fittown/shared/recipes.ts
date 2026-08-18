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
 * `source` value for a recipe frozen at the moment it was logged.
 *
 * A logged recipe is cloned — the food row and its ingredients — and the diary
 * entry points at the clone, so editing the live recipe afterwards cannot move
 * a meal that has already been eaten. The clone is never indexed in `foods_fts`
 * and never appears in the recipe list, which is why it needs its own `source`
 * rather than a flag: every existing `source = 'recipe'` filter then excludes
 * it without being touched.
 *
 * Nothing may recompute one. `recomputeRecipe()` writes its nutrition exactly
 * once, when it is minted; after that it is a record, not a derivation.
 */
export const RECIPE_LOG_SOURCE = 'recipe_log'

/**
 * Both kinds of recipe row.
 *
 * Anything asking "does this behave like a recipe on screen?" — portion units,
 * the gram rule, the editor link — means this set, not `RECIPE_SOURCE` alone.
 * A frozen stew is still a stew nobody weighed.
 */
export const RECIPE_SOURCES: readonly string[] = [RECIPE_SOURCE, RECIPE_LOG_SOURCE]

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
 * How deeply recipes may nest.
 *
 * A dressing inside a salad is two levels; that salad inside a meal-prep bowl
 * is three. A runaway guard rather than a rule, like `MAX_INGREDIENTS` — it is
 * what keeps the recompute cascade bounded and a recipe comprehensible on a
 * phone screen.
 */
export const MAX_RECIPE_DEPTH = 3

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
  /**
   * Is this ingredient currently part of the recipe? `0`/`false` means the user
   * has switched an optional one off; it then contributes nothing at all.
   *
   * **Absent means included.** Every caller that predates optional ingredients
   * — and every test fixture — leaves it undefined, and must keep behaving
   * exactly as it did.
   */
  is_included?: number | boolean
  /** Does the UI offer a switch for this one? Never affects the arithmetic. */
  is_optional?: number | boolean
}

/**
 * Does this ingredient count towards the recipe?
 *
 * Absent is included, for the reason on `is_included` above.
 */
export function ingredientIsIncluded(ingredient: RecipeIngredient): boolean {
  return ingredient.is_included === undefined || ingredient.is_included === null
    ? true
    : Boolean(ingredient.is_included)
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
 * A change to one recipe for one meal.
 *
 * Sent by the log screen, applied by the server, and the reason a diary entry
 * can say "3 eggs, no bacon" about a recipe that says four eggs and bacon. The
 * recipe is never touched — the change lands on the frozen copy the entry points
 * at, which is where a one-off belongs.
 *
 * `set` addresses a row that already exists; `add` puts in something the recipe
 * never had, which is why a frozen meal stores its own ingredient rows rather
 * than a diff against the recipe.
 */
export type RecipeAdjustment =
  | {
    op: 'set'
    ingredient_id: number
    /** New amount, in grams/ml. */
    grams?: number
    /** False skips it for this meal only. */
    included?: boolean
    /** A different food, for this meal only. */
    food_id?: number
    serving_label?: string | null
    serving_count?: number | null
  }
  | {
    op: 'add'
    food_id: number
    grams: number
    serving_label?: string | null
    serving_count?: number | null
  }

/** The shape `applyAdjustments()` needs to work on, beyond the roll-up's own. */
export interface AdjustableIngredient extends RecipeIngredient {
  id: number
  serving_label?: string | null
  serving_count?: number | null
}

/**
 * Apply a meal's adjustments to a recipe's ingredient list.
 *
 * Pure, and the single authority for "what is actually in this bowl": the log
 * screen calls it to draw the preview and to size the portion, and the server
 * calls it again to build the frozen copy. Two implementations would eventually
 * disagree, and the one nobody was looking at would be the one in the diary.
 *
 * `add` rows come out with `id: 0` — they have no ingredient row yet. Nothing
 * downstream addresses them by id, and giving them a fake one would invite it.
 */
export function applyAdjustments<T extends AdjustableIngredient>(
  ingredients: T[],
  adjustments: RecipeAdjustment[],
  /** Looks up a food row for an `add` or a swap. Missing foods are dropped. */
  lookupFood: (foodId: number) => Record<string, unknown> | null = () => null,
): AdjustableIngredient[] {
  const sets = new Map<number, Extract<RecipeAdjustment, { op: 'set' }>>()
  const adds: Extract<RecipeAdjustment, { op: 'add' }>[] = []

  for (const adjustment of adjustments) {
    if (adjustment.op === 'add') adds.push(adjustment)
    // Last one wins, so a client that sends two edits for one row is coherent
    // rather than order-dependent.
    else sets.set(adjustment.ingredient_id, adjustment)
  }

  const adjusted: AdjustableIngredient[] = ingredients.map((ingredient) => {
    const change = sets.get(ingredient.id)
    if (!change) return ingredient

    const swapped = change.food_id === undefined ? ingredient.food : lookupFood(change.food_id)

    return {
      ...ingredient,
      food: swapped,
      grams: change.grams === undefined ? ingredient.grams : change.grams,
      // A skipped ingredient stays in the list, marked, rather than being
      // filtered out: the frozen copy is a record of the meal, and "no bacon"
      // is part of what happened.
      is_included: change.included === undefined
        ? ingredient.is_included
        : (change.included ? 1 : 0),
      serving_label: change.serving_label === undefined
        ? ingredient.serving_label
        : change.serving_label,
      serving_count: change.serving_count === undefined
        ? ingredient.serving_count
        : change.serving_count,
    }
  })

  for (const addition of adds) {
    const food = lookupFood(addition.food_id)
    if (!food) continue
    adjusted.push({
      id: 0,
      grams: addition.grams,
      food,
      is_included: 1,
      is_optional: 0,
      serving_label: addition.serving_label ?? null,
      serving_count: addition.serving_count ?? null,
    })
  }

  return adjusted
}

/**
 * A food's name, short enough to read at a glance in a diary line.
 *
 * Lab-analysed and crowd-sourced names are long and front-load the useful part:
 * "Chicken, broiler or fryers, breast, skinless, boneless, meat only, cooked,
 * braised". Left whole, a note about it truncates before the words that say what
 * changed — "100 g Chicken, broiler or fryers, breast, sk…" — which is the half
 * a person is reading the line for.
 *
 * The first comma is where these names stop being specific and start being
 * qualifiers, so that is the cut. A name with no comma is clamped instead.
 */
export function shortFoodName(name: string, max = 24): string {
  const head = name.split(',')[0]!.trim()
  const base = head.length >= 3 ? head : name.trim()
  return base.length <= max ? base : `${base.slice(0, max - 1).trimEnd()}…`
}

/** One line of "what was different about this meal". */
export type AdjustmentNote =
  | { kind: 'amount'; name: string; from: string; to: string }
  | { kind: 'skipped'; name: string }
  | { kind: 'added'; name: string; amount: string }
  | { kind: 'swapped'; name: string; to: string }

/**
 * "150 g Egg instead of 200 g · no Bacon" — what the diary row says underneath.
 *
 * Kept to three changes plus a count. The line sits under a meal in a list of
 * meals, and a paragraph there is worse than "+2 more" for anybody scanning
 * their day; the frozen copy holds the full detail for whoever opens it.
 */
export function describeAdjustments(notes: AdjustmentNote[], max = 3): string | null {
  if (notes.length === 0) return null

  const phrase = (note: AdjustmentNote) => {
    switch (note.kind) {
      case 'amount':
        // A row measured in its own units already names the thing — "3 × egg" —
        // and repeating it gives "3 × egg Egg instead of 4 × egg". A row
        // measured in grams doesn't, so "150 g Egg instead of 200 g" needs it.
        return note.to.toLowerCase().includes(note.name.toLowerCase())
          ? `${note.to} instead of ${note.from}`
          : `${note.to} ${note.name} instead of ${note.from}`
      case 'skipped': return `no ${note.name}`
      case 'added': return `plus ${note.amount} ${note.name}`
      case 'swapped': return `${note.to} instead of ${note.name}`
    }
  }

  const shown = notes.slice(0, max).map(phrase)
  const hidden = notes.length - shown.length
  if (hidden > 0) shown.push(`+${hidden} more`)
  return shown.join(' · ')
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
  // `i.food`, `i.grams > 0` and inclusion are all tested here and again in the
  // nutrient loop below, and every test has to agree: a 0 g pinch of salt, an
  // unmatched "garlic powder" and a switched-off 200 g of bacon all contribute
  // no weight to the mixture, so none of them may count toward `rawG` — or
  // toward a nutrient's coverage, which would blank the whole recipe's vitamin
  // K on the strength of weight that isn't there. One predicate, used
  // everywhere it matters.
  const counts = (i: RecipeIngredient) =>
    i.food !== null && i.grams > 0 && ingredientIsIncluded(i)
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
  if (!isRecipe(food)) return true
  const weight = food.recipe_final_weight_g
  return typeof weight === 'number' && Number.isFinite(weight) && weight > 0
}

/**
 * How much of a nested recipe "1 serving" comes to, in grams.
 *
 * A nested ingredient stores resolved grams like every other, but those grams
 * are a *proportion* of the child, not a weight anybody measured: add 20 g of
 * oil to the dressing and "1 serving of dressing" is no longer 37 g. So the
 * amount is re-resolved from the child's current row every time the parent is
 * recomputed — see `recomputeRecipe()`.
 *
 * The two labels below are the only ones a recipe can offer: `recipeServingLabel()`
 * picks between them, and `food_servings` carries the whole-recipe row. Any
 * other label belongs to something else and is left exactly as it was, as is an
 * amount that was entered in grams — a weight is not a proportion.
 */
export function nestedPortionGrams(
  servingLabel: string | null,
  servingCount: number | null,
  child: { serving_grams?: unknown; recipe_servings?: unknown },
): number | null {
  if (!servingLabel || !servingCount || !(servingCount > 0)) return null

  const serving = child.serving_grams
  if (typeof serving !== 'number' || !Number.isFinite(serving) || serving <= 0) return null

  if (servingLabel === SERVING_LABEL) return serving * servingCount

  if (servingLabel === WHOLE_RECIPE_LABEL) {
    const servings = child.recipe_servings
    const count = typeof servings === 'number' && servings > 0 ? servings : 1
    return serving * count * servingCount
  }

  return null
}

/**
 * Is this `foods` row a recipe — live or frozen?
 *
 * Membership, not equality. A `recipe_log` row that failed this test would be
 * treated as an ordinary food, and the diary would start quoting gram weights
 * for a logged stew nobody ever weighed.
 */
export function isRecipe(food: { source?: unknown }): boolean {
  return typeof food.source === 'string' && RECIPE_SOURCES.includes(food.source)
}

/** Is this the frozen record of a meal, rather than a recipe you can edit? */
export function isRecipeLog(food: { source?: unknown }): boolean {
  return food.source === RECIPE_LOG_SOURCE
}

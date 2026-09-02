import type { DatabaseSync } from 'node:sqlite'
import { NUTRIENT_KEYS, scaleNutrients } from '#shared/nutrients'
import { uniqueCopyName } from '#shared/friends'
import type { AdjustmentNote, RecipeAdjustment } from '#shared/recipes'
import {
  MAX_RECIPE_DEPTH,
  RECIPE_LOG_SOURCE,
  RECIPE_SOURCE,
  RECIPE_SOURCES,
  SERVING_LABEL,
  WHOLE_RECIPE_LABEL,
  describeAdjustments,
  needsWholeRecipeOption,
  shortFoodName,
  nestedPortionGrams,
  recipeServingGrams,
  recipeServingLabel,
  rollUpRecipe,
  type RecipeRollUp,
} from '#shared/recipes'
// Explicit extension: `scripts/recompute-recipes.mjs` imports this module under
// plain `node`, which resolves ESM specifiers literally.
import { foodCols } from './foods.ts'

/**
 * Recipe storage.
 *
 * A recipe is a `foods` row with `source = 'recipe'` whose nutrient columns are
 * derived, never entered. `recomputeRecipe()` is the only thing that writes
 * them; every mutation route ends with a call to it inside a transaction, so
 * the food row can never disagree with the ingredients underneath it.
 *
 * Nothing here calls `createError` — these functions run under Vitest as well
 * as under Nitro, and HTTP status codes belong to the routes anyway.
 */

export interface RecipeRow {
  id: number
  name: string
  brand: string | null
  is_liquid: number
  recipe_servings: number | null
  recipe_final_weight_g: number | null
  recipe_instructions: string | null
  serving_grams: number | null
  owner_user_id: number | null
  [column: string]: unknown
}

export interface IngredientRow {
  id: number
  grams: number
  serving_label: string | null
  serving_count: number | null
  /** The line as pasted or scraped. Null on rows added the normal way. */
  raw_text: string | null
  /** Amount descriptor or prep note — "a lot of", "minced". */
  note: string | null
  /** The arithmetic the amount was typed as. For the input box only. */
  amount_formula: string | null
  sort_order: number
  /** Does the UI offer a switch for this one? */
  is_optional: number
  /** Is it currently counted? A switched-off optional contributes nothing. */
  is_included: number
  /**
   * The ingredient's food row, or **null** when the import couldn't match this
   * line to one with confidence. A null food contributes no nutrition and no
   * weight; `raw_text` is all such a row has to show for itself.
   */
  food: Record<string, unknown> | null
}

/**
 * Instructions are fetched only where a recipe is the subject.
 *
 * Deliberately not in `FOOD_FIELDS`: that list is also what a 60-row food
 * search selects, and hauling a page of prose through every query to render a
 * name and a calorie count is a cost with no reader.
 */
const RECIPE_EXTRA_COLS = 'f.recipe_instructions'

/** A recipe belonging to this user, or undefined — a guessed id finds nothing. */
export function findRecipe(
  db: DatabaseSync,
  id: number,
  userId: number,
  /**
   * Which kind of row to accept. Defaults to an editable recipe, and every
   * mutation route relies on that default: passing `RECIPE_LOG_SOURCE` here is
   * how the *read-only* view of a logged meal is fetched, and nothing that
   * writes may do it.
   */
  source: string = RECIPE_SOURCE,
): RecipeRow | undefined {
  return db
    .prepare(
      `SELECT ${foodCols()}, ${RECIPE_EXTRA_COLS} FROM foods f
       WHERE f.id = ? AND f.owner_user_id = ? AND f.source = ?`,
    )
    .get(id, userId, source) as RecipeRow | undefined
}

/**
 * Ingredients with their foods attached, in the order the user arranged them.
 *
 * `ri.id` is aliased: `foods` has an `id` too, and the later column would
 * silently overwrite the earlier one in the result object.
 *
 * The join is a LEFT join because an imported line may have no food. Note that
 * "unmatched" is decided by `ri.food_id IS NULL`, **not** by `f.id IS NULL`: a
 * LEFT join miss fills every one of `foodCols()`'s forty columns with null, and
 * the spread below would otherwise hand back an object that has `name`,
 * `kcal`, `is_liquid` and the rest — all null — and looks for all the world
 * like a real food row.
 */
export function listIngredients(db: DatabaseSync, recipeFoodId: number): IngredientRow[] {
  const rows = db
    .prepare(
      `SELECT ri.id AS ingredient_id, ri.grams, ri.serving_label, ri.serving_count,
              ri.raw_text, ri.note, ri.amount_formula, ri.sort_order, ri.food_id AS ri_food_id,
              ri.is_optional, ri.is_included,
              ${foodCols()}
       FROM recipe_ingredients ri
       LEFT JOIN foods f ON f.id = ri.food_id
       WHERE ri.recipe_food_id = ?
       ORDER BY ri.sort_order, ri.id`,
    )
    .all(recipeFoodId) as Record<string, unknown>[]

  return rows.map((row) => {
    const {
      ingredient_id: id,
      grams,
      serving_label: servingLabel,
      serving_count: servingCount,
      raw_text: rawText,
      note,
      amount_formula: amountFormula,
      sort_order: sortOrder,
      ri_food_id: foodId,
      is_optional: isOptional,
      is_included: isIncluded,
      ...food
    } = row
    return {
      id: Number(id),
      grams: Number(grams),
      serving_label: (servingLabel as string | null) ?? null,
      serving_count: servingCount === null ? null : Number(servingCount),
      raw_text: (rawText as string | null) ?? null,
      note: (note as string | null) ?? null,
      amount_formula: (amountFormula as string | null) ?? null,
      sort_order: Number(sortOrder),
      is_optional: Number(isOptional ?? 0),
      // Absent reads as included, matching the column default and
      // `ingredientIsIncluded()` — a database that predates the migration must
      // not silently drop every ingredient out of every recipe.
      is_included: isIncluded === null || isIncluded === undefined ? 1 : Number(isIncluded),
      food: foodId === null || foodId === undefined ? null : food,
    }
  })
}

/**
 * Recompute a recipe's food row from its ingredients.
 *
 * Call this at the end of *every* recipe mutation — renaming, re-serving,
 * re-weighing, and any ingredient change — inside the caller's transaction.
 * Returns the roll-up so a route can hand the numbers straight back.
 */
export function recomputeRecipe(db: DatabaseSync, recipeFoodId: number): RecipeRollUp {
  // Both sources: a snapshot is rolled up exactly once, at the moment it is
  // minted, by this same function. Nothing may recompute one afterwards — see
  // the guard in recomputeRecipeAndDependents().
  const recipe = db
    .prepare(
      `SELECT id, recipe_servings, recipe_final_weight_g FROM foods
       WHERE id = ? AND source IN (${RECIPE_SOURCES.map(() => '?').join(', ')})`,
    )
    .get(recipeFoodId, ...RECIPE_SOURCES) as
    | { recipe_servings: number | null; recipe_final_weight_g: number | null }
    | undefined

  if (!recipe) throw new Error(`No recipe with id ${recipeFoodId}`)

  const servings = recipe.recipe_servings && recipe.recipe_servings > 0
    ? recipe.recipe_servings
    : 1

  // Before anything is summed: "1 serving of the dressing" has to still mean
  // one serving of the dressing as it is now, not the gram figure it came to
  // when it was added. The only write a recompute makes to recipe_ingredients,
  // and it is re-resolving the user's stated intent rather than overriding it.
  resolveNestedPortions(db, recipeFoodId)

  const ingredients = listIngredients(db, recipeFoodId)
  const rollUp = rollUpRecipe(ingredients, recipe.recipe_final_weight_g)

  const servingGrams = recipeServingGrams(rollUp.basis_g, servings)
  // An empty recipe has no serving to speak of; null is what stops it being
  // logged and what makes "not recorded" show instead of a row of zeroes.
  const servingText = servingGrams === null ? null : recipeServingLabel(servings)

  const assignments = [
    ...NUTRIENT_KEYS.map((key) => `${key} = ?`),
    'serving_grams = ?',
    'serving_size_text = ?',
  ].join(', ')

  db.prepare(`UPDATE foods SET ${assignments} WHERE id = ?`).run(
    ...NUTRIENT_KEYS.map((key) => rollUp.per100[key] ?? null),
    servingGrams,
    servingText,
    recipeFoodId,
  )

  // Rebuilt rather than patched: the picker reads food_servings verbatim, and a
  // stale "whole recipe = 900 g" after an ingredient was removed would log the
  // wrong amount without ever looking wrong.
  db.prepare('DELETE FROM food_servings WHERE food_id = ?').run(recipeFoodId)
  if (servingGrams !== null && needsWholeRecipeOption(servings)) {
    db.prepare(
      'INSERT INTO food_servings (food_id, label, grams, is_default) VALUES (?, ?, ?, 0)',
    ).run(recipeFoodId, WHOLE_RECIPE_LABEL, rollUp.basis_g)
  }

  return rollUp
}

/**
 * Re-derive the grams of every nested recipe measured in the child's own units.
 *
 * Amounts entered in grams are left alone: someone weighed that, and a weight
 * is not a proportion. Only "1 serving" and "1 whole recipe" move, because only
 * those are claims about a share of something that can change underneath them.
 */
function resolveNestedPortions(db: DatabaseSync, recipeFoodId: number): void {
  const rows = db
    .prepare(
      `SELECT ri.id, ri.grams, ri.serving_label, ri.serving_count,
              child.serving_grams, child.recipe_servings
       FROM recipe_ingredients ri
       JOIN foods child ON child.id = ri.food_id
       WHERE ri.recipe_food_id = ? AND child.source = ?
         AND ri.serving_label IS NOT NULL AND ri.serving_count IS NOT NULL`,
    )
    .all(recipeFoodId, RECIPE_SOURCE) as {
      id: number
      grams: number
      serving_label: string
      serving_count: number
      serving_grams: number | null
      recipe_servings: number | null
    }[]

  if (rows.length === 0) return

  const update = db.prepare('UPDATE recipe_ingredients SET grams = ? WHERE id = ?')
  for (const row of rows) {
    const grams = nestedPortionGrams(row.serving_label, row.serving_count, row)
    // Unchanged rows are skipped rather than rewritten: this runs on every
    // recompute of every recipe, and most of them have nothing nested at all.
    if (grams === null || Math.abs(grams - row.grams) < 0.0001) continue
    update.run(grams, row.id)
  }
}

/**
 * How many levels of recipe sit *below* this one, counting itself.
 *
 * A recipe with nothing nested in it is 1. A salad holding a dressing is 2.
 *
 * `UNION ALL` with an explicit depth guard rather than `UNION`: the same child
 * legitimately appears twice (a dressing used in two components), and the guard
 * is what stops a cycle — which should be impossible, and is exactly the sort
 * of impossible that hangs a request — from recursing for ever.
 */
export function recipeDepthBelow(db: DatabaseSync, id: number): number {
  const row = db
    .prepare(
      `WITH RECURSIVE below(id, depth) AS (
         SELECT ?, 1
         UNION ALL
         SELECT ri.food_id, below.depth + 1
         FROM recipe_ingredients ri
         JOIN below ON ri.recipe_food_id = below.id
         JOIN foods f ON f.id = ri.food_id
         WHERE f.source = ? AND below.depth < ?
       )
       SELECT MAX(depth) AS depth FROM below`,
    )
    .get(id, RECIPE_SOURCE, MAX_RECIPE_DEPTH + 2) as { depth: number | null }

  return Number(row.depth ?? 1)
}

/**
 * Every live recipe that contains this one, however indirectly, with how far
 * above it each sits. The row for `id` itself is included, at depth 0.
 *
 * Frozen meals are **not** walked: `f.source = RECIPE_SOURCE` on the parent
 * side keeps a `recipe_log` out of every answer this returns. That single
 * condition is what stops a recompute cascade reaching a meal already eaten.
 */
function ancestorsWithDepth(db: DatabaseSync, id: number): { id: number; depth: number }[] {
  return db
    .prepare(
      `WITH RECURSIVE above(id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT ri.recipe_food_id, above.depth + 1
         FROM recipe_ingredients ri
         JOIN above ON ri.food_id = above.id
         JOIN foods f ON f.id = ri.recipe_food_id
         WHERE f.source = ? AND above.depth < ?
       )
       SELECT id, MAX(depth) AS depth FROM above GROUP BY id ORDER BY depth`,
    )
    .all(id, RECIPE_SOURCE, MAX_RECIPE_DEPTH + 2) as { id: number; depth: number }[]
}

/**
 * Every live recipe, children before the recipes that contain them.
 *
 * For the maintenance scripts, which re-roll the whole library after a bulk
 * change to `foods`. They used to walk `ORDER BY id`, which was fine until
 * recipes could nest: a salad created before the dressing it holds would be
 * rolled up from the dressing's stale numbers and stay wrong until the next
 * run. Sorting by how deep each one's own subtree goes puts every child ahead
 * of its parents in a single pass.
 */
export function recipesInDependencyOrder(
  db: DatabaseSync,
): { id: number; name: string }[] {
  const recipes = db
    .prepare('SELECT id, name FROM foods WHERE source = ? ORDER BY id')
    .all(RECIPE_SOURCE) as { id: number; name: string }[]

  return recipes
    .map((recipe) => ({ ...recipe, depth: recipeDepthBelow(db, Number(recipe.id)) }))
    .sort((a, b) => a.depth - b.depth)
    .map(({ id, name }) => ({ id: Number(id), name }))
}

/**
 * The other recipes in this one's family — its variants.
 *
 * A family is a flat set sharing `recipe_family_id`, which is the id of whichever
 * of them came first. Flat rather than a tree on purpose: "the three ways I make
 * chili" have no natural parent, and a tree would make deleting the first one a
 * question about the other two rather than just a deletion.
 *
 * Scoped to the owner as well as the family, so a family id guessed from
 * somebody else's recipe returns nothing.
 */
export function listVariants(
  db: DatabaseSync,
  familyId: number,
  excludeId: number,
  ownerId: number,
) {
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.recipe_servings, f.serving_grams, f.kcal
       FROM foods f
       WHERE f.recipe_family_id = ? AND f.id != ? AND f.owner_user_id = ? AND f.source = ?
       ORDER BY f.name COLLATE NOCASE`,
    )
    .all(familyId, excludeId, ownerId, RECIPE_SOURCE) as {
      id: number
      name: string
      kcal: number | null
      serving_grams: number | null
    }[]

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    // The figure the chip shows. Null when the variant is still empty, which is
    // not the same as zero.
    kcal_per_serving:
      row.kcal !== null && row.serving_grams !== null
        ? (row.kcal * row.serving_grams) / 100
        : null,
  }))
}

/** Recipes that contain this one, transitively. Excludes the recipe itself. */
export function ancestorIds(db: DatabaseSync, id: number): number[] {
  return ancestorsWithDepth(db, id)
    .filter((row) => row.depth > 0)
    .map((row) => Number(row.id))
}

/**
 * Recompute a recipe and everything built on top of it.
 *
 * Every mutation route ends here rather than in `recomputeRecipe()`: a parent
 * caches the sum of its children, so editing the dressing leaves the salad
 * wrong until the salad is re-rolled too.
 *
 * Order is by **longest** distance from the recipe that changed, not
 * depth-first. Given a diamond — A holds B and C, B holds C — a depth-first
 * walk up from C can reach A before B, roll A up from a stale B, and then skip
 * A on the way back because it has already been visited. Taking the maximum
 * depth per node and recomputing in that order gets it right in one pass.
 */
export function recomputeRecipeAndDependents(db: DatabaseSync, id: number): RecipeRollUp {
  const chain = ancestorsWithDepth(db, id)
  let first: RecipeRollUp | undefined

  for (const node of chain) {
    const rollUp = recomputeRecipe(db, Number(node.id))
    if (node.depth === 0) first = rollUp
  }

  // A recipe with nothing above it still has to be recomputed, and a frozen
  // meal never appears in the chain at all — both arrive here.
  return first ?? recomputeRecipe(db, id)
}

/**
 * May `childId` go into `parentId`?
 *
 * Two ways it may not: the child already contains the parent (which would make
 * a recipe that contains itself, and a rollup that never terminates), or the
 * resulting stack would be deeper than `MAX_RECIPE_DEPTH`.
 *
 * Returns null when it is fine, or the reason it isn't — phrased for the user,
 * because "invalid ingredient" tells somebody nothing about what to do next.
 */
export function nestingRefusal(
  db: DatabaseSync,
  parentId: number,
  childId: number,
): string | null {
  if (parentId === childId) return 'A recipe can’t contain itself.'

  const contained = db
    .prepare(
      `WITH RECURSIVE below(id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT ri.food_id, below.depth + 1
         FROM recipe_ingredients ri
         JOIN below ON ri.recipe_food_id = below.id
         JOIN foods f ON f.id = ri.food_id
         WHERE f.source = ? AND below.depth < ?
       )
       SELECT 1 AS found FROM below WHERE id = ? LIMIT 1`,
    )
    .get(childId, RECIPE_SOURCE, MAX_RECIPE_DEPTH + 2, parentId) as { found: number } | undefined

  if (contained) {
    const child = db.prepare('SELECT name FROM foods WHERE id = ?').get(childId) as
      | { name: string }
      | undefined
    const parent = db.prepare('SELECT name FROM foods WHERE id = ?').get(parentId) as
      | { name: string }
      | undefined
    return `${child?.name ?? 'That recipe'} already contains ${parent?.name ?? 'this one'}.`
  }

  // Checked from both sides: a two-level child dropped into a two-level parent
  // is too deep even though neither half is.
  const above = ancestorsWithDepth(db, parentId).reduce((max, row) => Math.max(max, row.depth), 0)
  const below = recipeDepthBelow(db, childId)
  if (above + 1 + below > MAX_RECIPE_DEPTH) {
    return `Recipes can only be nested ${MAX_RECIPE_DEPTH} deep.`
  }

  return null
}

/**
 * Keep `foods_fts` in step with a food's searchable text.
 *
 * `foods_fts` is an external-content table, so a delete has to replay the
 * *old* values verbatim — pass what was stored before the UPDATE, not after,
 * or the old name stays in the index and keeps turning up in search.
 */
export function reindexFood(
  db: DatabaseSync,
  id: number,
  previous: { name: string; brand: string | null },
  next: { name: string; brand: string | null },
): void {
  db.prepare(
    "INSERT INTO foods_fts(foods_fts, rowid, name, brand) VALUES('delete', ?, ?, ?)",
  ).run(id, previous.name, previous.brand)
  db.prepare('INSERT INTO foods_fts(rowid, name, brand) VALUES (?, ?, ?)').run(
    id,
    next.name,
    next.brand,
  )
}

/** Drop a food from the search index. Same old-values rule as above. */
export function unindexFood(
  db: DatabaseSync,
  id: number,
  previous: { name: string; brand: string | null },
): void {
  db.prepare(
    "INSERT INTO foods_fts(foods_fts, rowid, name, brand) VALUES('delete', ?, ?, ?)",
  ).run(id, previous.name, previous.brand)
}

export interface NewRecipeOptions {
  /** `RECIPE_SOURCE` by default; `RECIPE_LOG_SOURCE` for a frozen meal. */
  source?: string
  /**
   * Which family this recipe belongs to. Omitted means "its own", set after
   * the insert because the id isn't known until then. Pass `null` for a
   * snapshot: a frozen meal is not a member of anybody's collection.
   */
  familyId?: number | null
  /** The live recipe a snapshot was frozen from. */
  loggedFrom?: number | null
  /** What was changed for that one meal, in words. */
  logNote?: string | null
}

/**
 * Create an empty recipe. Returns the new food id.
 *
 * Indexed in `foods_fts` unless it is a snapshot — a frozen meal must never be
 * findable in search, and never being indexed is a stronger guarantee than
 * filtering it out of every query that reads the index.
 */
export function createRecipeFood(
  db: DatabaseSync,
  userId: number,
  name: string,
  servings = 1,
  options: NewRecipeOptions = {},
): number {
  const source = options.source ?? RECIPE_SOURCE
  const info = db
    .prepare(
      `INSERT INTO foods
         (source, owner_user_id, name, is_liquid, recipe_servings,
          logged_from_food_id, recipe_log_note)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      source,
      userId,
      name,
      servings,
      options.loggedFrom ?? null,
      options.logNote ?? null,
    )

  const id = Number(info.lastInsertRowid)

  if (source !== RECIPE_LOG_SOURCE) {
    // A recipe with no family is its own founder. Done here rather than with a
    // DEFAULT because the id doesn't exist until the row does.
    const familyId = options.familyId === undefined ? id : options.familyId
    db.prepare('UPDATE foods SET recipe_family_id = ? WHERE id = ?').run(familyId, id)
    db.prepare('INSERT INTO foods_fts(rowid, name, brand) VALUES (?, ?, NULL)').run(id, name)
  }

  return id
}

/** How many diary entries reference this food. Deleting is blocked above zero. */
export function countDiaryUses(db: DatabaseSync, foodId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM diary_entries WHERE food_id = ?')
    .get(foodId) as { c: number }
  return Number(row.c)
}

/** How many other recipes use this food as an ingredient. */
export function countRecipeUses(db: DatabaseSync, foodId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM recipe_ingredients WHERE food_id = ?')
    .get(foodId) as { c: number }
  return Number(row.c)
}

/**
 * One user's recipes, as the list screens want them.
 *
 * Deliberately not the full food rows: these screens show a name, a serving
 * count and an energy figure, and a recipe row carries forty nutrient columns.
 * `source` and `brand` come along because the Recipes tab on /add feeds these
 * rows straight into FoodResultList, which needs them to know it is looking at
 * a recipe — and therefore whether it may quote a weight.
 *
 * Takes a user id rather than reading the session, because a friend's recipe
 * list is the same list.
 */
export function listRecipeSummaries(db: DatabaseSync, userId: number) {
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.source, f.brand, f.is_liquid,
              f.recipe_servings, f.recipe_final_weight_g,
              f.serving_grams, f.kcal,
              COALESCE(f.recipe_family_id, f.id) AS family_id,
              -- Siblings, so the list can say "2 variants" without a second
              -- query per row. COALESCE for rows that predate the column.
              (SELECT COUNT(*) FROM foods v
               WHERE v.source = f.source AND v.owner_user_id = f.owner_user_id
                 AND COALESCE(v.recipe_family_id, v.id) = COALESCE(f.recipe_family_id, f.id)
                 AND v.id != f.id) AS variant_count,
              (SELECT COUNT(*) FROM recipe_ingredients ri
               WHERE ri.recipe_food_id = f.id) AS ingredient_count,
              -- So the list can say "2 need a food" on an imported recipe. It
              -- is the only prompt the user gets to go back and finish one.
              (SELECT COUNT(*) FROM recipe_ingredients ri
               WHERE ri.recipe_food_id = f.id AND ri.food_id IS NULL)
                AS unresolved_count
       FROM foods f
       WHERE f.owner_user_id = ? AND f.source = ?
       ORDER BY f.name COLLATE NOCASE`,
    )
    .all(userId, RECIPE_SOURCE) as (Record<string, unknown> & {
      kcal: number | null
      serving_grams: number | null
    })[]

  return rows.map((row) => ({
    ...row,
    // Energy for one serving — the number the list is actually read for.
    // Null when the recipe is still empty, which is not the same as zero.
    kcal_per_serving:
      row.kcal !== null && row.serving_grams !== null
        ? (row.kcal * row.serving_grams) / 100
        : null,
  }))
}

/**
 * Everything a recipe screen draws, for the owner or for someone reading it.
 *
 * The totals are recomputed here rather than read back off the food row so the
 * screen shows the same arithmetic the recompute will store — if the two ever
 * disagreed, this is where it would be visible.
 *
 * Returns undefined when `ownerId` doesn't own recipe `id`, which is what
 * makes a guessed id a 404 on every route that calls this.
 */
export function recipeDetail(
  db: DatabaseSync,
  id: number,
  ownerId: number,
  source: string = RECIPE_SOURCE,
) {
  const recipe = findRecipe(db, id, ownerId, source)
  if (!recipe) return undefined

  const ingredients = listIngredients(db, id)
  const rollUp = rollUpRecipe(ingredients, recipe.recipe_final_weight_g)

  const servings = recipe.recipe_servings && recipe.recipe_servings > 0
    ? recipe.recipe_servings
    : 1

  // Absent nutrients are dropped rather than sent as null, matching what
  // scaleNutrients() does for a diary entry — the UI renders a missing key as
  // "not recorded" and a zero as a real measurement.
  const totals: Record<string, number> = {}
  const perServing: Record<string, number> = {}
  for (const [key, value] of Object.entries(rollUp.totals)) {
    if (value === null) continue
    totals[key] = value
    perServing[key] = value / servings
  }

  return {
    recipe,
    ingredients: ingredients.map((ingredient) => ({
      id: ingredient.id,
      grams: ingredient.grams,
      serving_label: ingredient.serving_label,
      serving_count: ingredient.serving_count,
      raw_text: ingredient.raw_text,
      note: ingredient.note,
      amount_formula: ingredient.amount_formula,
      sort_order: ingredient.sort_order,
      is_optional: ingredient.is_optional,
      is_included: ingredient.is_included,
      food: ingredient.food,
      // An empty object, not a row of zeroes: the UI renders a missing key as
      // "not recorded", which is the honest answer for a line we never matched.
      nutrients: ingredient.food
        ? scaleNutrients(ingredient.food, ingredient.grams)
        : {},
    })),
    raw_g: rollUp.raw_g,
    basis_g: rollUp.basis_g,
    // What the totals below are *not* counting. The editor turns this into a
    // warning, because a recipe missing two of its ingredients still shows a
    // confident calorie figure and nothing else would say otherwise.
    unresolved_count: ingredients.filter((i) => i.food === null).length,
    totals,
    per_serving: perServing,
    /**
     * Which family this recipe belongs to, and who else is in it.
     *
     * `?? id` covers a recipe from before the column existed and a frozen meal,
     * which has no family at all — in both cases it is a family of one, and the
     * strip on screen shows nothing.
     */
    family_id: Number(recipe.recipe_family_id ?? id),
    variants: source === RECIPE_SOURCE
      ? listVariants(db, Number(recipe.recipe_family_id ?? id), id, ownerId)
      : [],
  }
}

/** One ingredient row, as `cloneRecipe()` reads it off the source recipe. */
interface SourceIngredient {
  id: number
  food_id: number | null
  grams: number
  serving_label: string | null
  serving_count: number | null
  raw_text: string | null
  note: string | null
  amount_formula: string | null
  sort_order: number
  is_optional: number
  is_included: number
  owner_user_id: number | null
  /** The ingredient food's own source — 'recipe' means copy it recursively. */
  source: string | null
}

export interface CloneOptions {
  /** Defaults to the source recipe's name, verbatim. */
  name?: string
  /**
   * Which family the clone joins. Omitted means "found its own"; `null` means
   * none at all, which is what a snapshot gets.
   */
  familyId?: number | null
  /** `RECIPE_SOURCE`, or `RECIPE_LOG_SOURCE` for a frozen meal. */
  source?: string
  loggedFrom?: number | null
  logNote?: string | null
  /**
   * Duplicate ingredient foods belonging to somebody else into `userId`'s own
   * foods. True when copying across users, false within one account — where
   * every ingredient is already yours and copying would just litter search.
   */
  localiseForeignFoods?: boolean
  /**
   * Foreign food id → the copy made of it, shared across a recursive copy so
   * one dressing used twice is duplicated once.
   */
  localised?: Map<number, number>
  /**
   * Changes to apply while copying, keyed by the **source** recipe's ingredient
   * ids. Applied here rather than to the finished clone because the clone's rows
   * have new ids, and mapping between them after the fact is a second thing to
   * keep correct.
   */
  adjustments?: RecipeAdjustment[]
}

/**
 * Duplicate a recipe — the food row and its ingredients — into `userId`'s.
 *
 * Three callers with three different reasons, one body: copying a friend's
 * recipe, saving a variant of your own, and freezing one at the moment it is
 * logged. They differ only in what they pass, and keeping them on one
 * implementation is what stops "a copy" and "a snapshot" drifting into
 * carrying different subsets of the recipe.
 *
 * Returns the new recipe's food id.
 */
export function cloneRecipe(
  db: DatabaseSync,
  sourceRecipeId: number,
  userId: number,
  options: CloneOptions = {},
): number {
  const source = db
    .prepare(
      `SELECT ${foodCols()}, ${RECIPE_EXTRA_COLS} FROM foods f
       WHERE f.id = ? AND f.source = ?`,
    )
    .get(sourceRecipeId, RECIPE_SOURCE) as RecipeRow | undefined

  if (!source) throw new Error(`No recipe with id ${sourceRecipeId}`)

  const servings = Number(source.recipe_servings ?? 1) || 1
  const newId = createRecipeFood(db, userId, options.name ?? String(source.name), servings, {
    source: options.source,
    familyId: options.familyId,
    loggedFrom: options.loggedFrom,
    logNote: options.logNote,
  })

  db.prepare(
    `UPDATE foods
     SET is_liquid = ?, recipe_final_weight_g = ?, recipe_instructions = ?
     WHERE id = ?`,
  ).run(
    source.is_liquid ? 1 : 0,
    source.recipe_final_weight_g ?? null,
    // The method travels with the mixture. A copied recipe without its steps is
    // a shopping list, and the source URL at the bottom is the attribution.
    source.recipe_instructions ?? null,
    newId,
  )

  // LEFT join: an imported recipe may carry lines that were never matched to a
  // food, and they have to come across too. Dropping them would hand someone a
  // vinaigrette with no salt and no oregano, with nothing on screen to say so.
  const ingredients = db
    .prepare(
      `SELECT ri.id, ri.food_id, ri.grams, ri.serving_label, ri.serving_count,
              ri.raw_text, ri.note, ri.amount_formula, ri.sort_order,
              ri.is_optional, ri.is_included,
              f.owner_user_id, f.source
       FROM recipe_ingredients ri
       LEFT JOIN foods f ON f.id = ri.food_id
       WHERE ri.recipe_food_id = ?
       ORDER BY ri.sort_order, ri.id`,
    )
    .all(sourceRecipeId) as SourceIngredient[]

  // One copy per distinct foreign food, however many times the recipe uses it —
  // and shared with the recursion below, so a dressing used by two components
  // of the same recipe is copied once, not twice.
  const localised = options.localised ?? new Map<number, number>()

  const sets = new Map<number, Extract<RecipeAdjustment, { op: 'set' }>>()
  const adds: Extract<RecipeAdjustment, { op: 'add' }>[] = []
  for (const adjustment of options.adjustments ?? []) {
    if (adjustment.op === 'add') adds.push(adjustment)
    else sets.set(adjustment.ingredient_id, adjustment)
  }

  const insert = db.prepare(
    `INSERT INTO recipe_ingredients
       (recipe_food_id, food_id, grams, serving_label, serving_count,
        raw_text, note, amount_formula, sort_order, is_optional, is_included)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const ingredient of ingredients) {
    const change = sets.get(Number(ingredient.id))
    // A swap for this meal only: the recipe still says butter.
    let foodId = change?.food_id ?? ingredient.food_id
    // Unmatched rows have nothing to localise — they are already just text.
    if (
      options.localiseForeignFoods
      && foodId !== null
      && ingredient.owner_user_id !== null
      && ingredient.owner_user_id !== userId
    ) {
      let copy = localised.get(foodId)
      if (copy === undefined) {
        // A nested recipe is copied *as a recipe*, recursively. Sending it
        // through copyCustomFoodInto() would flatten it into a plain food with
        // the right numbers, no ingredient list, and no way to tell it was ever
        // a recipe — and it would then stop tracking the dressing entirely.
        copy = ingredient.source === RECIPE_SOURCE
          ? cloneRecipe(db, foodId, userId, {
            localiseForeignFoods: true,
            localised,
          })
          : copyCustomFoodInto(db, foodId, userId)
        localised.set(foodId, copy)
      }
      foodId = copy
    }

    insert.run(
      newId,
      foodId,
      change?.grams ?? ingredient.grams,
      change?.serving_label === undefined ? ingredient.serving_label : change.serving_label,
      change?.serving_count === undefined ? ingredient.serving_count : change.serving_count,
      // The CHECK constraint needs one of the two. A row with no food that
      // somehow also has no text cannot be copied into a legal row, so give it
      // something rather than failing the whole copy.
      foodId === null ? (ingredient.raw_text ?? 'Unnamed ingredient') : ingredient.raw_text,
      ingredient.note,
      // An adjustment that set a new amount carries its own formula; one that
      // did not leaves the recipe's — a carried formula that no longer matches
      // the new amount is a case `fieldText()`'s invariant handles on redisplay.
      // `=== undefined`, not `??`, so an adjustment that explicitly cleared the
      // formula (a bump, a unit switch, a retyped plain number) stays cleared.
      change?.amount_formula === undefined ? ingredient.amount_formula : change.amount_formula,
      ingredient.sort_order,
      // Carried, not defaulted: a copy that forgot these would count somebody's
      // suggested bacon, and a frozen meal would silently regain an ingredient
      // the person skipped.
      ingredient.is_optional ?? 0,
      // Skipped for this meal. The row is still written — a frozen meal is a
      // record, and "no bacon" is part of what happened — it just counts for
      // nothing, exactly like an optional the user never switched on.
      change?.included === undefined
        ? (ingredient.is_included ?? 1)
        : (change.included ? 1 : 0),
    )
  }

  // Things the recipe never had. Appended after the copied rows, so the order
  // reads as "the recipe, then what I put in as well".
  let extraOrder = ingredients.length
  for (const addition of adds) {
    const food = db
      .prepare(
        'SELECT id, name FROM foods WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)',
      )
      .get(addition.food_id, userId) as { id: number; name: string } | undefined
    if (!food) continue

    insert.run(
      newId,
      food.id,
      addition.grams,
      addition.serving_label ?? null,
      addition.serving_count ?? null,
      null,
      null,
      addition.amount_formula ?? null,
      extraOrder,
      0,
      1,
    )
    extraOrder += 1
  }

  // The children were cloned above, so they are already rolled up by the time
  // this runs — which is what makes one pass enough here.
  recomputeRecipe(db, newId)
  return newId
}

/**
 * Copy someone else's recipe into `userId`'s own recipes.
 *
 * Used by both sharing routes — a friend's recipe and a public share link —
 * because "add this to my recipes" has to mean the same thing either way.
 *
 * The copy is **self-contained**. Ingredients that are Open Food Facts products
 * are shared rows and get referenced as they are, but an ingredient that is
 * somebody's *custom* food is copied too: pointing at a row you can't see would
 * give you a recipe that changes when they edit it, that vanishes from search,
 * and that pins their food row in place forever (`recipe_ingredients.food_id`
 * is ON DELETE RESTRICT). Copying is the only version of this that leaves both
 * people able to edit and delete their own things.
 *
 * The copy founds its **own** family. Whatever variants the original has are
 * the other person's collection, not yours; you copied one recipe.
 *
 * Returns the new recipe's food id.
 */
export function copyRecipeInto(
  db: DatabaseSync,
  sourceRecipeId: number,
  userId: number,
): number {
  const source = db
    .prepare('SELECT name FROM foods WHERE id = ? AND source = ?')
    .get(sourceRecipeId, RECIPE_SOURCE) as { name: string } | undefined

  if (!source) throw new Error(`No recipe with id ${sourceRecipeId}`)

  const taken = (
    db
      .prepare('SELECT name FROM foods WHERE owner_user_id = ? AND source = ?')
      .all(userId, RECIPE_SOURCE) as { name: string }[]
  ).map((row) => row.name)

  return cloneRecipe(db, sourceRecipeId, userId, {
    name: uniqueCopyName(String(source.name), taken),
    localiseForeignFoods: true,
  })
}

/**
 * Describe what a meal's adjustments changed, for the diary line.
 *
 * Reads the *source* rows so it can say "instead of 200 g". Formats the amount
 * the way the row is measured: a row entered as "4 × egg" is described in eggs,
 * because that is the change the person made.
 */
function noteAdjustments(
  db: DatabaseSync,
  recipeId: number,
  adjustments: RecipeAdjustment[],
): string | null {
  if (adjustments.length === 0) return null

  const rows = listIngredients(db, recipeId)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const notes: AdjustmentNote[] = []

  /** "4 × egg", or "200 g" when the row is measured by weight. */
  const amount = (
    grams: number,
    label: string | null,
    count: number | null,
    isLiquid: boolean,
  ) => (label && count
    ? `${Number(count.toFixed(2))} × ${label}`
    : `${Math.round(grams)} ${isLiquid ? 'ml' : 'g'}`)

  for (const adjustment of adjustments) {
    if (adjustment.op === 'add') {
      const food = db.prepare('SELECT name, is_liquid FROM foods WHERE id = ?')
        .get(adjustment.food_id) as { name: string; is_liquid: number } | undefined
      if (!food) continue
      notes.push({
        kind: 'added',
        name: shortFoodName(food.name),
        amount: amount(
          adjustment.grams,
          adjustment.serving_label ?? null,
          adjustment.serving_count ?? null,
          !!food.is_liquid,
        ),
      })
      continue
    }

    const row = byId.get(adjustment.ingredient_id)
    if (!row) continue
    const full = (row.food?.name as string | undefined) ?? row.raw_text ?? 'an ingredient'
    const name = shortFoodName(full)
    const isLiquid = !!row.food?.is_liquid

    if (adjustment.included === false) {
      notes.push({ kind: 'skipped', name })
      continue
    }
    if (adjustment.food_id !== undefined) {
      const swap = db.prepare('SELECT name FROM foods WHERE id = ?').get(adjustment.food_id) as
        | { name: string }
        | undefined
      notes.push({
        kind: 'swapped',
        name,
        to: swap ? shortFoodName(swap.name) : 'something else',
      })
      continue
    }
    if (adjustment.grams !== undefined && adjustment.grams !== row.grams) {
      notes.push({
        kind: 'amount',
        name,
        from: amount(row.grams, row.serving_label, row.serving_count, isLiquid),
        to: amount(
          adjustment.grams,
          adjustment.serving_label === undefined ? row.serving_label : adjustment.serving_label,
          adjustment.serving_count === undefined ? row.serving_count : adjustment.serving_count,
          isLiquid,
        ),
      })
    }
  }

  return describeAdjustments(notes)
}

/**
 * How many grams of a recipe a named portion comes to.
 *
 * The client sizes its preview against the recipe as it is; once a meal has been
 * adjusted, the frozen copy weighs something else, and "1 serving" has to mean a
 * serving *of what was eaten*. Re-deriving here makes the server the only
 * authority on the number that lands in the diary — and it is the same helper a
 * nested recipe uses, because it is the same question.
 *
 * Returns null for a plain gram portion, where the client's figure is the whole
 * truth and nothing needs re-deriving.
 */
export function resolveLoggedGrams(
  db: DatabaseSync,
  foodId: number,
  servingLabel: string | null,
  servingCount: number | null,
): number | null {
  if (servingLabel !== SERVING_LABEL && servingLabel !== WHOLE_RECIPE_LABEL) return null

  const row = db
    .prepare('SELECT serving_grams, recipe_servings FROM foods WHERE id = ?')
    .get(foodId) as { serving_grams: number | null; recipe_servings: number | null } | undefined

  if (!row) return null
  return nestedPortionGrams(servingLabel, servingCount, row)
}

/**
 * Freeze a recipe at the moment it is logged, and return the frozen food id.
 *
 * The diary entry points at this, not at the recipe, which is what makes
 * "adding butter today changes what last Tuesday's bowl reports" stop being
 * true. The clone carries the recipe's name verbatim so the diary reads the
 * same as it always did; it is never indexed for search, never listed among
 * the user's recipes, and never recomputed again.
 *
 * `adjustments` are this meal's changes — three eggs instead of four, no bacon,
 * a handful of extra cheese. They land on the copy, so the recipe still says
 * what it always said.
 *
 * Ownership is checked here rather than trusted from the caller: this mints a
 * row, and a recipe id guessed from another account must find nothing.
 */
export function snapshotRecipeForLog(
  db: DatabaseSync,
  recipeId: number,
  userId: number,
  adjustments: RecipeAdjustment[] = [],
): { id: number; servingGrams: number | null; note: string | null } {
  const recipe = findRecipe(db, recipeId, userId)
  if (!recipe) throw new Error(`No recipe with id ${recipeId} for user ${userId}`)

  // Built from the source rows, so it can say "instead of 200 g" — which means
  // reading them before the clone exists.
  const note = noteAdjustments(db, recipeId, adjustments)

  const id = cloneRecipe(db, recipeId, userId, {
    source: RECIPE_LOG_SOURCE,
    familyId: null,
    loggedFrom: recipeId,
    logNote: note,
    adjustments,
  })

  const row = db.prepare('SELECT serving_grams FROM foods WHERE id = ?').get(id) as
    | { serving_grams: number | null }
    | undefined

  return { id, servingGrams: row?.serving_grams ?? null, note }
}

/**
 * Re-apply a meal's adjustments to the frozen copy already behind an entry.
 *
 * Editing an entry, not rewriting history: the copy belongs to exactly one
 * diary row, so changing it in place is the same act as changing that row. The
 * ingredient ids are the **copy's** own, because that is what the screen showing
 * the meal was drawn from.
 *
 * Nutrition is re-derived from the ingredient foods as they are *now*, which is
 * right — re-saving is a fresh act of logging, and a stale figure is the thing
 * being corrected.
 */
export function resnapshotForLog(
  db: DatabaseSync,
  snapshotId: number,
  userId: number,
  adjustments: RecipeAdjustment[],
): { servingGrams: number | null; note: string | null } {
  const snapshot = db
    .prepare('SELECT id, name, recipe_log_note FROM foods WHERE id = ? AND owner_user_id = ? AND source = ?')
    .get(snapshotId, userId, RECIPE_LOG_SOURCE) as
    | { id: number; recipe_log_note: string | null }
    | undefined

  if (!snapshot) throw new Error(`No logged meal with id ${snapshotId} for user ${userId}`)

  const fresh = noteAdjustments(db, snapshotId, adjustments)

  const update = db.prepare(
    `UPDATE recipe_ingredients
     SET grams = ?, serving_label = ?, serving_count = ?, amount_formula = ?,
         food_id = ?, is_included = ?
     WHERE id = ? AND recipe_food_id = ?`,
  )
  const insert = db.prepare(
    `INSERT INTO recipe_ingredients
       (recipe_food_id, food_id, grams, serving_label, serving_count,
        amount_formula, sort_order, is_optional, is_included)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`,
  )

  const rows = listIngredients(db, snapshotId)
  const byId = new Map(rows.map((row) => [row.id, row]))
  let order = rows.length

  for (const adjustment of adjustments) {
    if (adjustment.op === 'add') {
      const food = db
        .prepare(
          'SELECT id FROM foods WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)',
        )
        .get(adjustment.food_id, userId) as { id: number } | undefined
      if (!food) continue
      insert.run(
        snapshotId,
        food.id,
        adjustment.grams,
        adjustment.serving_label ?? null,
        adjustment.serving_count ?? null,
        adjustment.amount_formula ?? null,
        order,
      )
      order += 1
      continue
    }

    const row = byId.get(adjustment.ingredient_id)
    if (!row) continue
    update.run(
      adjustment.grams ?? row.grams,
      adjustment.serving_label === undefined ? row.serving_label : adjustment.serving_label,
      adjustment.serving_count === undefined ? row.serving_count : adjustment.serving_count,
      adjustment.amount_formula === undefined ? row.amount_formula : adjustment.amount_formula,
      adjustment.food_id ?? (row.food?.id as number | undefined) ?? null,
      adjustment.included === undefined ? row.is_included : (adjustment.included ? 1 : 0),
      row.id,
      snapshotId,
    )
  }

  // Keep whatever the meal already said it differed by: this edit is described
  // against the copy, so a second pass would otherwise report "no changes" and
  // erase the note explaining the first one.
  const note = fresh ?? snapshot.recipe_log_note
  db.prepare('UPDATE foods SET recipe_log_note = ? WHERE id = ?').run(note, snapshotId)

  recomputeRecipe(db, snapshotId)
  const row = db.prepare('SELECT serving_grams FROM foods WHERE id = ?').get(snapshotId) as
    | { serving_grams: number | null }
    | undefined

  return { servingGrams: row?.serving_grams ?? null, note }
}

/**
 * Delete the frozen copy behind a diary entry.
 *
 * **Call this after the entry is gone, never before.** `diary_entries.food_id`
 * is ON DELETE RESTRICT, so the other order fails the whole transaction.
 *
 * Ingredient rows and `food_servings` follow by cascade, and there is no FTS
 * row to remove because a snapshot was never indexed. Scoped to the owner and
 * to the frozen source, so this can be handed any food id and will refuse to
 * touch a real recipe.
 */
export function deleteRecipeLog(db: DatabaseSync, foodId: number, userId: number): void {
  db.prepare(
    'DELETE FROM foods WHERE id = ? AND owner_user_id = ? AND source = ?',
  ).run(foodId, userId, RECIPE_LOG_SOURCE)
}

/** Columns worth carrying onto a copied custom food. */
const COPIED_FOOD_FIELDS = [
  'name', 'brand', 'quantity', 'categories', 'image_url',
  'serving_size_text', 'serving_grams', 'is_liquid', 'nutriscore', 'nova_group',
  ...NUTRIENT_KEYS,
]

/**
 * Duplicate somebody's custom food into `userId`'s own foods.
 *
 * Reuses an identical food the user already has — same name, brand and energy —
 * so copying two of a friend's recipes that both use their "Mum's sourdough"
 * doesn't leave two of them in your search results.
 *
 * The barcode is deliberately dropped: `idx_foods_source_barcode` is unique
 * over `(source, barcode)`, so carrying it across would collide with the row
 * being copied. A copy that can't be re-scanned is a smaller loss than a copy
 * that can't be made.
 */
export function copyCustomFoodInto(
  db: DatabaseSync,
  sourceFoodId: number,
  userId: number,
): number {
  const source = db
    .prepare(`SELECT ${foodCols()} FROM foods f WHERE f.id = ?`)
    .get(sourceFoodId) as Record<string, unknown> | undefined

  if (!source) throw new Error(`No food with id ${sourceFoodId}`)

  // `IS` rather than `=` so a food with no energy figure matches another with
  // no energy figure instead of failing every comparison the way NULL does.
  const existing = db
    .prepare(
      `SELECT id FROM foods
       WHERE owner_user_id = ? AND source = 'custom'
         AND LOWER(name) = LOWER(?)
         AND COALESCE(LOWER(brand), '') = COALESCE(LOWER(?), '')
         AND kcal IS ?`,
    )
    .get(userId, source.name, source.brand ?? null, source.kcal ?? null) as
    | { id: number }
    | undefined

  if (existing) return Number(existing.id)

  const columns = ['source', 'owner_user_id', ...COPIED_FOOD_FIELDS]
  const info = db
    .prepare(
      `INSERT INTO foods (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run('custom', userId, ...COPIED_FOOD_FIELDS.map((key) => (source[key] ?? null) as never))

  const id = Number(info.lastInsertRowid)
  // Same rule as any other path that creates a food: index it, or it is
  // invisible to search for ever after.
  db.prepare('INSERT INTO foods_fts(rowid, name, brand) VALUES (?, ?, ?)').run(
    id,
    source.name,
    source.brand ?? null,
  )
  return id
}

/**
 * Put a recipe's ingredients in the given order.
 *
 * Takes the **whole** list. A partial one throws rather than being applied: a
 * client working from a stale copy of the recipe would otherwise scramble the
 * rows it didn't know about, and the rows it did send would look right, so
 * nothing on screen would say so.
 *
 * Compared as sets, which also catches a duplicate id — `[7, 7]` against two
 * rows has the right length and would leave one row at whatever order it had.
 */
export function reorderIngredients(
  db: DatabaseSync,
  recipeFoodId: number,
  ids: number[],
): void {
  const existing = (
    db
      .prepare('SELECT id FROM recipe_ingredients WHERE recipe_food_id = ?')
      .all(recipeFoodId) as { id: number }[]
  ).map((row) => Number(row.id))

  const sent = new Set(ids)
  const complete = sent.size === ids.length
    && existing.length === ids.length
    && existing.every((id) => sent.has(id))

  if (!complete) {
    throw new Error('The order must list every ingredient in this recipe exactly once')
  }

  const update = db.prepare(
    'UPDATE recipe_ingredients SET sort_order = ? WHERE id = ? AND recipe_food_id = ?',
  )
  ids.forEach((id, index) => update.run(index, id, recipeFoodId))
}

/** Next free slot at the end of a recipe's ingredient list. */
export function nextIngredientOrder(db: DatabaseSync, recipeFoodId: number): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM recipe_ingredients WHERE recipe_food_id = ?',
    )
    .get(recipeFoodId) as { next: number }
  return Number(row.next)
}

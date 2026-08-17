import type { DatabaseSync } from 'node:sqlite'
import { NUTRIENT_KEYS, scaleNutrients } from '#shared/nutrients'
import { uniqueCopyName } from '#shared/friends'
import {
  RECIPE_SOURCE,
  needsWholeRecipeOption,
  recipeServingGrams,
  recipeServingLabel,
  rollUpRecipe,
  WHOLE_RECIPE_LABEL,
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
  serving_grams: number | null
  owner_user_id: number | null
  [column: string]: unknown
}

export interface IngredientRow {
  id: number
  grams: number
  serving_label: string | null
  serving_count: number | null
  sort_order: number
  food: Record<string, unknown>
}

/** A recipe belonging to this user, or undefined — a guessed id finds nothing. */
export function findRecipe(
  db: DatabaseSync,
  id: number,
  userId: number,
): RecipeRow | undefined {
  return db
    .prepare(
      `SELECT ${foodCols()} FROM foods f
       WHERE f.id = ? AND f.owner_user_id = ? AND f.source = ?`,
    )
    .get(id, userId, RECIPE_SOURCE) as RecipeRow | undefined
}

/**
 * Ingredients with their foods attached, in the order the user arranged them.
 *
 * `ri.id` is aliased: `foods` has an `id` too, and the later column would
 * silently overwrite the earlier one in the result object.
 */
export function listIngredients(db: DatabaseSync, recipeFoodId: number): IngredientRow[] {
  const rows = db
    .prepare(
      `SELECT ri.id AS ingredient_id, ri.grams, ri.serving_label, ri.serving_count,
              ri.sort_order, ${foodCols()}
       FROM recipe_ingredients ri
       JOIN foods f ON f.id = ri.food_id
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
      sort_order: sortOrder,
      ...food
    } = row
    return {
      id: Number(id),
      grams: Number(grams),
      serving_label: (servingLabel as string | null) ?? null,
      serving_count: servingCount === null ? null : Number(servingCount),
      sort_order: Number(sortOrder),
      food,
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
  const recipe = db
    .prepare(
      'SELECT id, recipe_servings, recipe_final_weight_g FROM foods WHERE id = ? AND source = ?',
    )
    .get(recipeFoodId, RECIPE_SOURCE) as
    | { recipe_servings: number | null; recipe_final_weight_g: number | null }
    | undefined

  if (!recipe) throw new Error(`No recipe with id ${recipeFoodId}`)

  const servings = recipe.recipe_servings && recipe.recipe_servings > 0
    ? recipe.recipe_servings
    : 1
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

/** Create an empty recipe and index it. Returns the new food id. */
export function createRecipeFood(
  db: DatabaseSync,
  userId: number,
  name: string,
  servings = 1,
): number {
  const info = db
    .prepare(
      `INSERT INTO foods (source, owner_user_id, name, is_liquid, recipe_servings)
       VALUES (?, ?, ?, 0, ?)`,
    )
    .run(RECIPE_SOURCE, userId, name, servings)

  const id = Number(info.lastInsertRowid)
  db.prepare('INSERT INTO foods_fts(rowid, name, brand) VALUES (?, ?, NULL)').run(id, name)
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
              (SELECT COUNT(*) FROM recipe_ingredients ri
               WHERE ri.recipe_food_id = f.id) AS ingredient_count
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
export function recipeDetail(db: DatabaseSync, id: number, ownerId: number) {
  const recipe = findRecipe(db, id, ownerId)
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
      sort_order: ingredient.sort_order,
      food: ingredient.food,
      nutrients: scaleNutrients(ingredient.food, ingredient.grams),
    })),
    raw_g: rollUp.raw_g,
    basis_g: rollUp.basis_g,
    totals,
    per_serving: perServing,
  }
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
 * Returns the new recipe's food id.
 */
export function copyRecipeInto(
  db: DatabaseSync,
  sourceRecipeId: number,
  userId: number,
): number {
  const source = db
    .prepare(`SELECT ${foodCols()} FROM foods f WHERE f.id = ? AND f.source = ?`)
    .get(sourceRecipeId, RECIPE_SOURCE) as RecipeRow | undefined

  if (!source) throw new Error(`No recipe with id ${sourceRecipeId}`)

  const taken = (
    db
      .prepare('SELECT name FROM foods WHERE owner_user_id = ? AND source = ?')
      .all(userId, RECIPE_SOURCE) as { name: string }[]
  ).map((row) => row.name)

  const name = uniqueCopyName(String(source.name), taken)
  const servings = Number(source.recipe_servings ?? 1) || 1
  const newId = createRecipeFood(db, userId, name, servings)

  db.prepare('UPDATE foods SET is_liquid = ?, recipe_final_weight_g = ? WHERE id = ?').run(
    source.is_liquid ? 1 : 0,
    source.recipe_final_weight_g ?? null,
    newId,
  )

  const ingredients = db
    .prepare(
      `SELECT ri.food_id, ri.grams, ri.serving_label, ri.serving_count, ri.sort_order,
              f.owner_user_id
       FROM recipe_ingredients ri
       JOIN foods f ON f.id = ri.food_id
       WHERE ri.recipe_food_id = ?
       ORDER BY ri.sort_order, ri.id`,
    )
    .all(sourceRecipeId) as {
      food_id: number
      grams: number
      serving_label: string | null
      serving_count: number | null
      sort_order: number
      owner_user_id: number | null
    }[]

  // One copy per distinct foreign food, however many times the recipe uses it.
  const localised = new Map<number, number>()

  const insert = db.prepare(
    `INSERT INTO recipe_ingredients
       (recipe_food_id, food_id, grams, serving_label, serving_count, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  for (const ingredient of ingredients) {
    let foodId = ingredient.food_id
    if (ingredient.owner_user_id !== null && ingredient.owner_user_id !== userId) {
      let copy = localised.get(ingredient.food_id)
      if (copy === undefined) {
        copy = copyCustomFoodInto(db, ingredient.food_id, userId)
        localised.set(ingredient.food_id, copy)
      }
      foodId = copy
    }

    insert.run(
      newId,
      foodId,
      ingredient.grams,
      ingredient.serving_label,
      ingredient.serving_count,
      ingredient.sort_order,
    )
  }

  recomputeRecipe(db, newId)
  return newId
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

/** Next free slot at the end of a recipe's ingredient list. */
export function nextIngredientOrder(db: DatabaseSync, recipeFoodId: number): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM recipe_ingredients WHERE recipe_food_id = ?',
    )
    .get(recipeFoodId) as { next: number }
  return Number(row.next)
}

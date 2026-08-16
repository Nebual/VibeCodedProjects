import type { DatabaseSync } from 'node:sqlite'
import { NUTRIENT_KEYS } from '#shared/nutrients'
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

/** Next free slot at the end of a recipe's ingredient list. */
export function nextIngredientOrder(db: DatabaseSync, recipeFoodId: number): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM recipe_ingredients WHERE recipe_food_id = ?',
    )
    .get(recipeFoodId) as { next: number }
  return Number(row.next)
}

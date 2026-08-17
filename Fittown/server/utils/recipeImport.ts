import type { DatabaseSync } from 'node:sqlite'
import type { ParsedIngredientLine } from '#shared/ingredientText'
import { MAX_INGREDIENTS } from '#shared/recipes'
import { matchIngredient } from './ingredientMatch.ts'
import { createRecipeFood, recomputeRecipe } from './recipes.ts'

/**
 * Building a recipe out of parsed lines.
 *
 * Shared by both importers — a pasted list and a scraped page — so that a
 * recipe imported from a URL is indistinguishable from one typed in by hand
 * once it lands. Everything upstream of here differs; nothing downstream does.
 */

export interface RecipeImportInput {
  name: string
  lines: ParsedIngredientLine[]
  instructions?: string | null
  /** Null leaves it at 1, which is what `createRecipeFood` defaults to. */
  servings?: number | null
}

export interface RecipeImportResult {
  id: number
  ingredient_count: number
  /** Lines stored as text because nothing matched them with confidence. */
  unresolved_count: number
}

/**
 * Create a recipe from parsed lines. Call inside a transaction.
 *
 * Note the single `recomputeRecipe` at the end rather than one per ingredient:
 * the recompute rolls up the whole mixture and rewrites forty nutrient columns,
 * so doing it per row turns a forty-line paste into forty full roll-ups to
 * reach the same answer.
 */
export function importRecipe(
  db: DatabaseSync,
  userId: number,
  input: RecipeImportInput,
): RecipeImportResult {
  const lines = input.lines.slice(0, MAX_INGREDIENTS)

  const servings = input.servings && input.servings > 0 ? input.servings : 1
  const recipeId = createRecipeFood(db, userId, input.name, servings)

  if (input.instructions) {
    db.prepare('UPDATE foods SET recipe_instructions = ? WHERE id = ?')
      .run(input.instructions, recipeId)
  }

  const insert = db.prepare(
    `INSERT INTO recipe_ingredients
       (recipe_food_id, food_id, grams, serving_label, serving_count,
        raw_text, note, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  let unresolved = 0

  lines.forEach((line, index) => {
    const match = matchIngredient(db, userId, line.name)
    if (!match) unresolved += 1

    insert.run(
      recipeId,
      match?.food_id ?? null,
      line.grams,
      line.serving_label,
      line.serving_count,
      // Kept on matched rows too, so the user can see that "Balsamic Vinegar of
      // Modena" came from the line they actually wrote.
      line.raw.slice(0, 200),
      line.note?.slice(0, 200) ?? null,
      index,
    )
  })

  recomputeRecipe(db, recipeId)

  return {
    id: recipeId,
    ingredient_count: lines.length,
    unresolved_count: unresolved,
  }
}

const FALLBACK_NAME = 'Imported recipe'

/**
 * A name for a recipe that didn't come with one — a paste with no title, or a
 * page whose structured data omitted it.
 *
 * Numbered against what the user already has rather than dated: the server has
 * no business deciding what day it is (the user's timezone lives in a cookie
 * the client sends with a date, and inventing one here is the bug AGENTS.md §3
 * warns about), and three rows all called "Imported recipe" is a list nobody
 * can use.
 */
export function fallbackRecipeName(db: DatabaseSync, userId: number): string {
  const taken = new Set(
    (
      db
        .prepare(
          `SELECT name FROM foods
           WHERE owner_user_id = ? AND source = 'recipe' AND name LIKE ?`,
        )
        .all(userId, `${FALLBACK_NAME}%`) as { name: string }[]
    ).map((row) => row.name.trim().toLowerCase()),
  )

  if (!taken.has(FALLBACK_NAME.toLowerCase())) return FALLBACK_NAME

  for (let n = 2; n < 1000; n++) {
    const candidate = `${FALLBACK_NAME} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return FALLBACK_NAME
}

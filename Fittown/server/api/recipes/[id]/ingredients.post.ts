import { RECIPE_SOURCE } from '#shared/recipes'
import { findRecipe, nextIngredientOrder, recomputeRecipe } from '../../../utils/recipes'

/** No mixture is worth a hundred lines; the cap is a runaway guard, not a rule. */
const MAX_INGREDIENTS = 100

/**
 * Add an ingredient.
 *
 * The client sends the same shape the diary does — resolved grams plus the
 * label and count it came from — because the same portion picker produced it.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const recipeId = assertId(getRouterParam(event, 'id'), 'recipe id')
  const body = await readBody<Record<string, unknown>>(event)

  const foodId = assertId(body.food_id, 'food_id')
  const grams = assertNumber(body.grams, 'grams', { min: 0.1, max: 20000 })
  const servingLabel = optionalText(body.serving_label, 60)
  const servingCount = optionalNumber(body.serving_count, 'serving_count', {
    min: 0.01,
    max: 1000,
  })

  return transact((db) => {
    const recipe = findRecipe(db, recipeId, user.id)
    if (!recipe) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

    const food = db
      .prepare(
        'SELECT id, source FROM foods WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)',
      )
      .get(foodId, user.id) as { id: number; source: string } | undefined

    if (!food) throw createError({ statusCode: 404, statusMessage: 'Food not found' })

    // Recipes inside recipes are blocked for now. The arithmetic would work —
    // a recipe carries real per-100g values — but editing an inner recipe would
    // silently stale every recipe built on it, which needs a dependency walk
    // and cycle detection this app doesn't have yet.
    if (food.source === RECIPE_SOURCE) {
      throw createError({
        statusCode: 400,
        statusMessage: 'A recipe can’t be an ingredient in another recipe yet',
      })
    }

    const { count } = db
      .prepare('SELECT COUNT(*) AS count FROM recipe_ingredients WHERE recipe_food_id = ?')
      .get(recipeId) as { count: number }
    if (count >= MAX_INGREDIENTS) {
      throw createError({
        statusCode: 400,
        statusMessage: `A recipe can hold at most ${MAX_INGREDIENTS} ingredients`,
      })
    }

    const info = db
      .prepare(
        `INSERT INTO recipe_ingredients
           (recipe_food_id, food_id, grams, serving_label, serving_count, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recipeId,
        foodId,
        grams,
        servingLabel,
        servingCount,
        nextIngredientOrder(db, recipeId),
      )

    recomputeRecipe(db, recipeId)
    return { id: Number(info.lastInsertRowid) }
  })
})

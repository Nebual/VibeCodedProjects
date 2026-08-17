import { MAX_INGREDIENTS, RECIPE_SOURCE } from '#shared/recipes'
import { findRecipe, nextIngredientOrder, recomputeRecipe } from '../../../utils/recipes'

/**
 * Add an ingredient.
 *
 * The client sends the same shape the diary does — resolved grams plus the
 * label and count it came from — because the same portion picker produced it.
 *
 * `food_id` is optional. Omitting it (with `raw_text` instead) records a line
 * we have a name for but no nutrition: what the bulk importer produces when it
 * can't match "a lot of oregano" to anything with confidence.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const recipeId = assertId(getRouterParam(event, 'id'), 'recipe id')
  const body = await readBody<Record<string, unknown>>(event)

  const rawText = optionalText(body.raw_text, 200)
  const foodId = body.food_id === undefined || body.food_id === null
    ? null
    : assertId(body.food_id, 'food_id')

  if (foodId === null && rawText === null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'An ingredient needs either a food_id or raw_text',
    })
  }

  // Zero is allowed — see the note in the schema. An ingredient with no stated
  // amount contributes nothing rather than being guessed at.
  const grams = assertNumber(body.grams, 'grams', { min: 0, max: 20000 })
  const servingLabel = optionalText(body.serving_label, 60)
  const servingCount = optionalNumber(body.serving_count, 'serving_count', {
    min: 0.01,
    max: 1000,
  })
  const note = optionalText(body.note, 200)

  return transact((db) => {
    const recipe = findRecipe(db, recipeId, user.id)
    if (!recipe) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

    if (foodId !== null) {
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
           (recipe_food_id, food_id, grams, serving_label, serving_count,
            raw_text, note, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recipeId,
        foodId,
        grams,
        servingLabel,
        servingCount,
        rawText,
        note,
        nextIngredientOrder(db, recipeId),
      )

    recomputeRecipe(db, recipeId)
    return { id: Number(info.lastInsertRowid) }
  })
})

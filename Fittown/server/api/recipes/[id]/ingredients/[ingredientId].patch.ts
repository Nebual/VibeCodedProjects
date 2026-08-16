import { findRecipe, recomputeRecipe } from '../../../../utils/recipes'

/** Change how much of an ingredient the recipe uses. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const recipeId = assertId(getRouterParam(event, 'id'), 'recipe id')
  const ingredientId = assertId(getRouterParam(event, 'ingredientId'), 'ingredient id')
  const body = await readBody<Record<string, unknown>>(event)

  const sets: string[] = []
  const params: unknown[] = []

  if (body.grams !== undefined) {
    sets.push('grams = ?')
    params.push(assertNumber(body.grams, 'grams', { min: 0.1, max: 20000 }))
  }
  if (body.serving_label !== undefined) {
    sets.push('serving_label = ?')
    params.push(optionalText(body.serving_label, 60))
  }
  if (body.serving_count !== undefined) {
    sets.push('serving_count = ?')
    params.push(optionalNumber(body.serving_count, 'serving_count', { min: 0.01, max: 1000 }))
  }

  if (sets.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to update' })
  }

  return transact((db) => {
    // Ownership is checked on the recipe, then the ingredient is scoped to it,
    // so an id guessed from another user's recipe updates nothing.
    if (!findRecipe(db, recipeId, user.id)) {
      throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })
    }

    const info = db
      .prepare(
        `UPDATE recipe_ingredients SET ${sets.join(', ')}
         WHERE id = ? AND recipe_food_id = ?`,
      )
      .run(...params, ingredientId, recipeId)

    if (info.changes === 0) {
      throw createError({ statusCode: 404, statusMessage: 'Ingredient not found' })
    }

    recomputeRecipe(db, recipeId)
    return { ok: true }
  })
})

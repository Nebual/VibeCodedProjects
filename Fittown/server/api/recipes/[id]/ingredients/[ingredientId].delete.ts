import { findRecipe, recomputeRecipe } from '../../../../utils/recipes'

/** Take an ingredient out. The recipe re-totals immediately. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const recipeId = assertId(getRouterParam(event, 'id'), 'recipe id')
  const ingredientId = assertId(getRouterParam(event, 'ingredientId'), 'ingredient id')

  return transact((db) => {
    if (!findRecipe(db, recipeId, user.id)) {
      throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })
    }

    const info = db
      .prepare('DELETE FROM recipe_ingredients WHERE id = ? AND recipe_food_id = ?')
      .run(ingredientId, recipeId)

    if (info.changes === 0) {
      throw createError({ statusCode: 404, statusMessage: 'Ingredient not found' })
    }

    recomputeRecipe(db, recipeId)
    return { ok: true }
  })
})

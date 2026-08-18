import { findRecipe, recomputeRecipeAndDependents, reorderIngredients } from '../../../utils/recipes'

/**
 * Put a recipe's ingredients in a given order — `{ ids: [7, 3, 9] }` becomes
 * `sort_order` 0, 1, 2.
 *
 * Deliberately not `ingredients/order`: that path sits beside
 * `[ingredientId].patch.ts` and would depend on static-beats-dynamic routing to
 * avoid being read as an ingredient called "order".
 *
 * Order changes no arithmetic, but the recompute stays: "every mutation route
 * ends in one" is easier to keep true than a carve-out, and it costs a handful
 * of rows.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const recipeId = assertId(getRouterParam(event, 'id'), 'recipe id')
  const body = await readBody<{ ids?: unknown }>(event)

  if (!Array.isArray(body.ids)) {
    throw createError({ statusCode: 400, statusMessage: 'ids must be an array' })
  }
  const ids = body.ids.map((value, index) => assertId(value, `ids[${index}]`))

  return transact((db) => {
    if (!findRecipe(db, recipeId, user.id)) {
      throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })
    }

    try {
      reorderIngredients(db, recipeId, ids)
    } catch (err) {
      // The util throws a plain Error — it runs under Vitest too, where HTTP
      // status codes mean nothing. Turning it into a 400 is this layer's job.
      throw createError({ statusCode: 400, statusMessage: (err as Error).message })
    }

    recomputeRecipeAndDependents(db, recipeId)
    return { ok: true }
  })
})

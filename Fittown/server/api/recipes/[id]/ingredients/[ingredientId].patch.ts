import { RECIPE_LOG_SOURCE, RECIPE_SOURCE } from '#shared/recipes'
import {
  findRecipe,
  nestingRefusal,
  recomputeRecipeAndDependents,
} from '../../../../utils/recipes'

/**
 * Change how much of an ingredient the recipe uses — or, for a line the
 * importer couldn't match, say what food it actually is.
 *
 * Attaching a food is the one edit that turns an unresolved row into a real
 * one, so it is the route the "3 ingredients need a food" prompt leads to.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const recipeId = assertId(getRouterParam(event, 'id'), 'recipe id')
  const ingredientId = assertId(getRouterParam(event, 'ingredientId'), 'ingredient id')
  const body = await readBody<Record<string, unknown>>(event)

  const sets: string[] = []
  const params: unknown[] = []

  if (body.grams !== undefined) {
    // Zero is allowed: "pinch of salt" has no amount to speak of, and forcing a
    // tenth of a gram on it would be inventing a measurement.
    sets.push('grams = ?')
    params.push(assertNumber(body.grams, 'grams', { min: 0, max: 20000 }))
  }
  if (body.serving_label !== undefined) {
    sets.push('serving_label = ?')
    params.push(optionalText(body.serving_label, 60))
  }
  if (body.serving_count !== undefined) {
    sets.push('serving_count = ?')
    params.push(optionalNumber(body.serving_count, 'serving_count', { min: 0.01, max: 1000 }))
  }
  if (body.note !== undefined) {
    sets.push('note = ?')
    params.push(optionalText(body.note, 200))
  }

  // Switching one off, or on, for the recipe as a whole — as distinct from
  // skipping it once when logging a meal, which never touches the recipe.
  if (body.is_included !== undefined) {
    sets.push('is_included = ?')
    params.push(body.is_included ? 1 : 0)
  }

  // The constraint the schema can't carry (no CHECK without a table rebuild):
  // a required ingredient is always counted, so clearing `is_optional` has to
  // switch it back on — otherwise the recipe keeps a permanently missing
  // ingredient with no control on screen to bring it back.
  if (body.is_optional !== undefined) {
    sets.push('is_optional = ?')
    params.push(body.is_optional ? 1 : 0)
    if (!body.is_optional) {
      sets.push('is_included = ?')
      params.push(1)
    }
  }

  // Resolved separately from the loop above: unlike the rest, this one has to
  // check that the food exists and is visible to this user before it is stored.
  const foodId = body.food_id === undefined ? null : assertId(body.food_id, 'food_id')

  if (sets.length === 0 && foodId === null) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to update' })
  }

  return transact((db) => {
    // Ownership is checked on the recipe, then the ingredient is scoped to it,
    // so an id guessed from another user's recipe updates nothing.
    if (!findRecipe(db, recipeId, user.id)) {
      throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })
    }

    if (foodId !== null) {
      const food = db
        .prepare(
          'SELECT id, source FROM foods WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)',
        )
        .get(foodId, user.id) as { id: number; source: string } | undefined

      if (!food) throw createError({ statusCode: 404, statusMessage: 'Food not found' })
      // Same rules as adding one: see the comments in ingredients.post.ts.
      if (food.source === RECIPE_LOG_SOURCE) {
        throw createError({
          statusCode: 400,
          statusMessage: 'That is a record of a meal already logged, not a recipe.',
        })
      }
      if (food.source === RECIPE_SOURCE) {
        const refusal = nestingRefusal(db, recipeId, foodId)
        if (refusal) throw createError({ statusCode: 400, statusMessage: refusal })
      }

      sets.push('food_id = ?')
      params.push(foodId)
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

    recomputeRecipeAndDependents(db, recipeId)
    return { ok: true }
  })
})

import { findRecipe, recomputeRecipe, reindexFood } from '../../utils/recipes'

/**
 * Rename a recipe, change how many servings it makes, or record its yield.
 *
 * Every one of these changes what a serving is, so all of them end in a
 * recompute — inside the same transaction, so a crash can't leave the food row
 * describing a recipe that no longer exists in that shape.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'recipe id')
  const body = await readBody<Record<string, unknown>>(event)

  const sets: string[] = []
  const params: unknown[] = []
  let newName: string | null = null

  if (body.name !== undefined) {
    newName = assertText(body.name, 'name', 200)
    sets.push('name = ?')
    params.push(newName)
  }
  if (body.servings !== undefined) {
    sets.push('recipe_servings = ?')
    params.push(assertNumber(body.servings, 'servings', { min: 0.1, max: 100 }))
  }
  if (body.final_weight_g !== undefined) {
    // Null is meaningful here: it's the user saying they don't know the yield,
    // which is what takes gram portions back off the picker.
    sets.push('recipe_final_weight_g = ?')
    params.push(optionalNumber(body.final_weight_g, 'final_weight_g', { min: 1, max: 50000 }))
  }
  if (body.is_liquid !== undefined) {
    sets.push('is_liquid = ?')
    params.push(body.is_liquid ? 1 : 0)
  }

  if (sets.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to update' })
  }

  return transact((db) => {
    const recipe = findRecipe(db, id, user.id)
    if (!recipe) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

    db.prepare(`UPDATE foods SET ${sets.join(', ')} WHERE id = ? AND owner_user_id = ?`).run(
      ...params,
      id,
      user.id,
    )

    // The search index is external-content, so a rename has to replay the old
    // text to remove it. `recipe` still holds the pre-update values.
    if (newName !== null && newName !== recipe.name) {
      reindexFood(
        db,
        id,
        { name: recipe.name, brand: recipe.brand },
        { name: newName, brand: recipe.brand },
      )
    }

    recomputeRecipe(db, id)
    return { ok: true }
  })
})

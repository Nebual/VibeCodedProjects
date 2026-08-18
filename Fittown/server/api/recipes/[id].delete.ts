import { countDiaryUses, countRecipeUses, findRecipe, unindexFood } from '../../utils/recipes'

/**
 * Delete a recipe.
 *
 * Logging a recipe now points the diary entry at a frozen copy, so a recipe you
 * have eaten a hundred times has nothing referencing it and deletes cleanly —
 * the meals survive, each holding the version it was logged with, and their
 * `logged_from_food_id` goes null.
 *
 * The 409 below still stands, for entries logged *before* that change: those
 * point straight at this row, `diary_entries.food_id` is ON DELETE RESTRICT,
 * and there is no snapshot under them to survive on. Check first and say so
 * plainly rather than surfacing a constraint error the user can't act on.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'recipe id')

  return transact((db) => {
    const recipe = findRecipe(db, id, user.id)
    if (!recipe) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

    const logged = countDiaryUses(db, id)
    if (logged > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: `Logged ${logged} ${logged === 1 ? 'time' : 'times'}. Remove those diary entries first.`,
      })
    }

    const usedBy = countRecipeUses(db, id)
    if (usedBy > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Used as an ingredient in another recipe.',
      })
    }

    unindexFood(db, id, { name: recipe.name, brand: recipe.brand })
    // The ingredient rows go with it: recipe_food_id is ON DELETE CASCADE.
    db.prepare('DELETE FROM foods WHERE id = ? AND owner_user_id = ?').run(id, user.id)

    return { ok: true }
  })
})

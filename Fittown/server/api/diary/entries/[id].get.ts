import { recipeDetail } from '../../../utils/recipes'
import { RECIPE_LOG_SOURCE } from '#shared/recipes'

/**
 * One diary entry, with what was actually in it.
 *
 * Only meals logged from a recipe have anything to show here — the frozen copy
 * behind the entry, read through the same `recipeDetail()` the recipe screens
 * use, so "what did I eat" and "what does the recipe say" are rendered by one
 * piece of code.
 *
 * Read-only by construction: the editor routes all go through `findRecipe()`,
 * which only ever matches `source = 'recipe'`, so nothing reachable from here
 * can mutate a frozen meal. Changing one goes through
 * `PATCH /api/diary/entries/[id]` with `adjustments`.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'entry id')

  const db = useDb()
  const entry = db
    .prepare(
      `SELECT d.id, d.date, d.meal, d.grams, d.serving_label, d.serving_count,
              d.food_id, f.source, f.name, f.recipe_log_note, f.logged_from_food_id
       FROM diary_entries d JOIN foods f ON f.id = d.food_id
       WHERE d.id = ? AND d.user_id = ?`,
    )
    .get(id, user.id) as (Record<string, unknown> & { source: string; food_id: number }) | undefined

  if (!entry) throw createError({ statusCode: 404, statusMessage: 'Entry not found' })

  return {
    entry,
    detail: entry.source === RECIPE_LOG_SOURCE
      ? recipeDetail(db, entry.food_id, user.id, RECIPE_LOG_SOURCE) ?? null
      : null,
  }
})

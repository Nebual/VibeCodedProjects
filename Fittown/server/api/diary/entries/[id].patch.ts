import { RECIPE_LOG_SOURCE } from '#shared/recipes'
import { assertAdjustments } from '../../../utils/adjustments'
import { resnapshotForLog, resolveLoggedGrams } from '../../../utils/recipes'

/**
 * Adjust the portion, move an entry to a different meal, or change what was in
 * it.
 *
 * `adjustments` reach the frozen copy behind the entry, not the recipe: this is
 * how "actually it was three eggs" gets fixed after the fact. Only a meal logged
 * from a recipe has one, so anything else is refused rather than silently
 * ignored.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'entry id')
  const body = await readBody<Record<string, unknown>>(event)

  const sets: string[] = []
  const params: unknown[] = []

  if (body.grams !== undefined) {
    sets.push('grams = ?')
    params.push(assertNumber(body.grams, 'grams', { min: 0.1, max: 20000 }))
  }
  if (body.meal !== undefined) {
    sets.push('meal = ?')
    params.push(assertMeal(body.meal))
  }
  if (body.serving_label !== undefined) {
    sets.push('serving_label = ?')
    params.push(optionalText(body.serving_label, 60))
  }
  if (body.serving_count !== undefined) {
    sets.push('serving_count = ?')
    params.push(optionalNumber(body.serving_count, 'serving_count', { min: 0.01, max: 1000 }))
  }
  if (body.amount_formula !== undefined) {
    sets.push('amount_formula = ?')
    params.push(optionalText(body.amount_formula, 100))
  }

  const adjustments = assertAdjustments(body.adjustments)

  if (sets.length === 0 && adjustments.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to update' })
  }

  return transact((db) => {
    // Read first: re-snapshotting needs the food id, and everything here has to
    // be scoped to this user so an id guessed from another account is a no-op.
    const entry = db
      .prepare(
        `SELECT d.id, d.food_id, d.serving_label, d.serving_count, f.source
         FROM diary_entries d JOIN foods f ON f.id = d.food_id
         WHERE d.id = ? AND d.user_id = ?`,
      )
      .get(id, user.id) as
      | { food_id: number; serving_label: string | null; serving_count: number | null; source: string }
      | undefined

    if (!entry) throw createError({ statusCode: 404, statusMessage: 'Entry not found' })

    if (adjustments.length > 0 && entry.source !== RECIPE_LOG_SOURCE) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Only a meal logged from a recipe can be adjusted',
      })
    }

    if (sets.length > 0) {
      db.prepare(`UPDATE diary_entries SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
        .run(...params, id, user.id)
    }

    if (adjustments.length > 0) {
      resnapshotForLog(db, entry.food_id, user.id, adjustments)

      // The meal now weighs something else, so a portion expressed in servings
      // has to be re-derived — the same reason logging one does it. Read the
      // labels back rather than trusting `entry`, since this request may just
      // have changed them.
      const current = db
        .prepare('SELECT serving_label, serving_count FROM diary_entries WHERE id = ?')
        .get(id) as { serving_label: string | null; serving_count: number | null }

      const grams = resolveLoggedGrams(
        db,
        entry.food_id,
        current.serving_label,
        current.serving_count,
      )
      if (grams !== null) {
        db.prepare('UPDATE diary_entries SET grams = ? WHERE id = ? AND user_id = ?')
          .run(grams, id, user.id)
      }
    }

    return { ok: true }
  })
})

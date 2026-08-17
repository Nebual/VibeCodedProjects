import { scaleNutrients, sumNutrients, type NutrientTotals } from '#shared/nutrients'
import { friendPermissions, requireSharedSection } from '../../../utils/friends'
import { foodCols } from '../../../utils/foods'

/**
 * What a friend ate on one day.
 *
 * A narrower thing than your own `/api/diary`: meals, what they came to, and
 * the day's water — no goals, no biometric rows to fill in, no latest weight,
 * because none of that is being edited here. Workouts ride along only if the
 * exercise switch is on too, since that's the switch they govern.
 *
 * The date arrives from the caller in *their* timezone, as everywhere else in
 * this app; a friend in another timezone reading "16 August" gets the 16th as
 * the diary's owner filed it, which is the only reading that makes sense.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'friend id')
  const day = assertDate(getQuery(event).date)

  const db = useDb()
  requireSharedSection(db, user.id, id, 'share_diary')
  const permissions = friendPermissions(db, id)

  const entries = db
    .prepare(
      `SELECT d.id AS entry_id, d.meal, d.grams, d.serving_label, d.serving_count,
              ${foodCols()}
       FROM diary_entries d
       JOIN foods f ON f.id = d.food_id
       WHERE d.user_id = ? AND d.date = ?
       ORDER BY d.sort_order, d.id`,
    )
    .all(id, day) as Record<string, unknown>[]

  const byMeal: Record<string, unknown[]> = {
    breakfast: [], lunch: [], dinner: [], snack: [],
  }
  const vectors: NutrientTotals[] = []

  for (const row of entries) {
    const grams = Number(row.grams)
    const nutrients = scaleNutrients(row, grams)
    vectors.push(nutrients)

    const {
      entry_id: entryId, meal, grams: _grams, serving_label: servingLabel,
      serving_count: servingCount, ...food
    } = row

    ;(byMeal[String(meal)] ??= []).push({
      id: entryId,
      grams,
      serving_label: servingLabel,
      serving_count: servingCount,
      food,
      nutrients,
    })
  }

  const water = db
    .prepare(
      'SELECT COALESCE(SUM(amount_ml), 0) AS total_ml FROM water_entries WHERE user_id = ? AND date = ?',
    )
    .get(id, day) as { total_ml: number }

  const workouts = permissions.share_exercise
    ? db
        .prepare(
          `SELECT w.id, w.duration_min, w.calories, w.effort, w.sets, w.reps,
                  w.distance_km, e.name AS exercise_name, e.category
           FROM workout_entries w
           JOIN exercises e ON e.id = w.exercise_id
           WHERE w.user_id = ? AND w.date = ?
           ORDER BY w.id`,
        )
        .all(id, day)
    : []

  return {
    date: day,
    meals: byMeal,
    totals: sumNutrients(vectors),
    water_ml: Number(water.total_ml),
    workouts,
  }
})

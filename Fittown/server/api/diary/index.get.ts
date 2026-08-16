import { scaleNutrients, sumNutrients, type NutrientTotals } from '#shared/nutrients'
import { foodCols } from '../../utils/foods'

/**
 * Everything needed to render one day: food entries by meal, water, workouts,
 * goals and the rolled-up totals.
 *
 * Assembled server-side in one round trip so the diary paints in a single
 * request — this is the screen users open dozens of times a day, often on a
 * phone with a slow connection.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { date } = getQuery(event)
  const day = assertDate(date)

  const db = useDb()

  const entries = db
    .prepare(
      // d.id is aliased: both tables have an `id`, and the later column would
      // otherwise silently overwrite the earlier one in the result object.
      `SELECT d.id AS entry_id, d.meal, d.grams, d.serving_label,
              d.serving_count, d.sort_order,
              ${foodCols()}
       FROM diary_entries d
       JOIN foods f ON f.id = d.food_id
       WHERE d.user_id = ? AND d.date = ?
       ORDER BY d.sort_order, d.id`,
    )
    .all(user.id, day) as Record<string, unknown>[]

  // Attach the portion-scaled nutrient vector to each entry so the client
  // never has to redo the per-100g maths.
  const byMeal: Record<string, unknown[]> = {
    breakfast: [], lunch: [], dinner: [], snack: [],
  }
  const vectors: NutrientTotals[] = []

  for (const row of entries) {
    const grams = Number(row.grams)
    const nutrients = scaleNutrients(row, grams)
    vectors.push(nutrients)

    const meal = String(row.meal)
    ;(byMeal[meal] ??= []).push({
      id: row.entry_id,
      grams,
      serving_label: row.serving_label,
      serving_count: row.serving_count,
      food: pickFood(row),
      nutrients,
    })
  }

  const water = db
    .prepare(
      'SELECT id, amount_ml, created_at FROM water_entries WHERE user_id = ? AND date = ? ORDER BY id',
    )
    .all(user.id, day) as { amount_ml: number }[]

  const workouts = db
    .prepare(
      `SELECT w.id, w.duration_min, w.calories, w.effort, w.sets, w.reps, w.weight_kg,
              w.distance_km, w.notes, e.name AS exercise_name, e.category, e.id AS exercise_id
       FROM workout_entries w
       JOIN exercises e ON e.id = w.exercise_id
       WHERE w.user_id = ? AND w.date = ?
       ORDER BY w.id`,
    )
    .all(user.id, day) as { calories: number | null }[]

  const goals = db.prepare('SELECT * FROM user_goals WHERE user_id = ?').get(user.id)

  const weight = db
    .prepare('SELECT weight_kg FROM weight_entries WHERE user_id = ? AND date = ?')
    .get(user.id, day) as { weight_kg: number } | undefined

  // The workout calorie estimate uses the most recent weight, not this day's,
  // so the client needs it too — otherwise the "≈320 kcal" shown before saving
  // is computed against a different body weight than the figure stored after.
  const latest = db
    .prepare(
      'SELECT weight_kg FROM weight_entries WHERE user_id = ? ORDER BY date DESC LIMIT 1',
    )
    .get(user.id) as { weight_kg: number } | undefined

  // Every tracked measurement, with the day's reading attached where there is
  // one. Sending the full type list (not just the days's entries) is what lets
  // the diary offer an empty row to fill in.
  const biometrics = db
    .prepare(
      `SELECT t.id, t.name, t.unit, t.sort_order, b.value
       FROM biometric_types t
       LEFT JOIN biometric_entries b
         ON b.type_id = t.id AND b.user_id = t.user_id AND b.date = ?
       WHERE t.user_id = ?
       ORDER BY t.sort_order, t.id`,
    )
    .all(day, user.id)

  return {
    date: day,
    meals: byMeal,
    totals: sumNutrients(vectors),
    water: {
      entries: water,
      total_ml: water.reduce((sum, w) => sum + w.amount_ml, 0),
    },
    workouts: {
      entries: workouts,
      total_calories: workouts.reduce((sum, w) => sum + (w.calories ?? 0), 0),
      total_minutes: (workouts as { duration_min: number | null }[]).reduce(
        (sum, w) => sum + (w.duration_min ?? 0),
        0,
      ),
    },
    goals,
    weight_kg: weight?.weight_kg ?? null,
    latest_weight_kg: latest?.weight_kg ?? null,
    biometrics,
  }
})

/** Strip the diary-entry columns back out of the joined row, leaving the food. */
function pickFood(row: Record<string, unknown>) {
  const {
    entry_id: _entryId, meal: _meal, grams: _grams, serving_label: _sl,
    serving_count: _sc, sort_order: _so, ...food
  } = row
  return food
}

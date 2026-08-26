import { scaleNutrients, sumNutrients, type NutrientTotals } from '#shared/nutrients'
import {
  describeSchedule,
  occursOn,
  type ReminderScheduleRule,
} from '#shared/reminders'
import { GOAL_REDUCTION_KCAL, computeGoalSuggestion } from '#shared/goalSuggestion'
import { foodCols } from '../../utils/foods'
import { HYDRATION_ML_SQL } from '../../utils/hydration'
import { getGoalAdjustment, weeklyDailyKcals } from '../../utils/goalSuggestion'

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

  // Drinks logged in the food diary count toward the goal automatically —
  // see server/utils/hydration.ts for which foods qualify and why.
  const foodWater = db
    .prepare(
      `SELECT COALESCE(SUM(${HYDRATION_ML_SQL}), 0) AS ml
       FROM diary_entries d
       JOIN foods f ON f.id = d.food_id
       WHERE d.user_id = ? AND d.date = ?`,
    )
    .get(user.id, day) as { ml: number }

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

  const goals = db.prepare('SELECT * FROM user_goals WHERE user_id = ?').get(user.id) as Record<
    string,
    unknown
  >

  // The "lower today's goal?" nudge. Once the day has an accept/dismiss on
  // record, that decision stands — accepting shaves the reduction off this
  // day's effective goal; either way, the nudge itself doesn't reappear.
  const adjustment = getGoalAdjustment(db, user.id, day)
  const goalSuggestion =
    adjustment === null
      ? computeGoalSuggestion(weeklyDailyKcals(db, user.id, day), Number(goals.calorie_goal))
      : null
  if (adjustment === 'accepted') {
    goals.calorie_goal = Number(goals.calorie_goal) - GOAL_REDUCTION_KCAL
  }

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

  // Reminders visible on this day: created on or before it, and not removed
  // before it. A removal is a removal *date*, so past days keep the checkbox
  // they had when the reminder still existed; that day and later lose it.
  // Each row carries the day's tick, if there was one, plus the schedule rule
  // in force that day — a reminder only *appears* (or shows as due) per its
  // rule; the full history lets the UI label past days with what applied then.
  const reminderRows = db
    .prepare(
      `SELECT r.id, r.name,
              rc.done AS done
       FROM reminders r
       LEFT JOIN reminder_checks rc
         ON rc.reminder_id = r.id AND rc.user_id = r.user_id AND rc.date = ?
       WHERE r.user_id = ? AND r.created_on <= ?
         AND (r.removed_on IS NULL OR r.removed_on > ?)
       ORDER BY r.sort_order, r.id`,
    )
    .all(day, user.id, day, day) as {
    id: number
    name: string
    done: number | null
  }[]

  // One pass over every schedule rule in force so far — instead of one query
  // per reminder — then the newest rule per reminder wins.
  const allRules = db
    .prepare(
      `SELECT reminder_id, effective_from, freq, interval, byweekday, day_of_month
       FROM reminder_schedules
       WHERE reminder_id IN (${reminderRows.map(() => '?').join(',') || 'NULL'})
         AND effective_from <= ?
       ORDER BY reminder_id, effective_from DESC, id DESC`,
    )
    .all(...reminderRows.map((r) => r.id), day) as Record<string, unknown>[]

  const newestRule = new Map<number, Record<string, unknown>>()
  for (const rule of allRules) {
    const id = Number(rule.reminder_id)
    if (!newestRule.has(id)) newestRule.set(id, rule)
  }

  const toRule = (row: Record<string, unknown> | undefined): ReminderScheduleRule | null => {
    if (!row) return null
    return {
      effective_from: String(row.effective_from),
      freq: row.freq as ReminderScheduleRule['freq'],
      interval: Number(row.interval),
      byweekday: String(row.byweekday)
        .split(',')
        .filter((s) => s !== '')
        .map(Number),
      day_of_month: row.day_of_month === null ? null : Number(row.day_of_month),
    }
  }

  const reminders = []
  for (const row of reminderRows) {
    // A day with no rule yet (created before recurrence existed) behaves as
    // daily. Skipped days ("Delete Today's") hide the row entirely.
    if (row.done === 0) continue

    const rule = toRule(newestRule.get(row.id))
    /** Whether this reminder's schedule produces an occurrence on this day. */
    const occurs = rule === null || occursOn(rule, day)

    // A non-daily reminder only shows on its scheduled days (a ticked day
    // still shows, so history never loses a box once checked).
    if (!occurs && row.done !== 1) continue

    reminders.push({
      id: row.id,
      name: row.name,
      done: row.done === 1,
      occurs,
      schedule: rule,
      schedule_label: rule && rule.freq !== 'daily' ? describeSchedule(rule) : null,
    })
  }

  return {
    date: day,
    meals: byMeal,
    totals: sumNutrients(vectors),
    water: {
      entries: water,
      from_food_ml: foodWater.ml,
      total_ml: water.reduce((sum, w) => sum + w.amount_ml, 0) + foodWater.ml,
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
    goal_suggestion: goalSuggestion,
    weight_kg: weight?.weight_kg ?? null,
    latest_weight_kg: latest?.weight_kg ?? null,
    biometrics,
    reminders,
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

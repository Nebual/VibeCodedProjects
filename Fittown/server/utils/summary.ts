import type { DatabaseSync } from 'node:sqlite'

/**
 * Per-day rollups over a date range — the data behind every trends chart.
 *
 * Extracted from the route because a friend's trends draw the same charts from
 * the same numbers. One implementation means the two screens can't drift into
 * disagreeing about what a week of calories was.
 *
 * Aggregated in SQL rather than by loading every entry: a month of diary rows
 * is a lot of JSON to ship just to add up four numbers per day.
 */

/**
 * Which goals travel with the summary.
 *
 * `full` is the owner's own screen. `chart` is what a friend gets: the three
 * figures the charts actually draw a line for, and none of the body metrics
 * (birth year, height, sex, activity level) that live in the same row and are
 * nobody else's business.
 */
export type GoalScope = 'full' | 'chart'

const CHART_GOAL_FIELDS = ['calorie_goal', 'weight_unit', 'goal_weight_kg'] as const

export function summarise(
  db: DatabaseSync,
  userId: number,
  start: string,
  end: string,
  goalScope: GoalScope = 'full',
) {
  const food = db
    .prepare(
      `SELECT d.date AS date,
              SUM(f.kcal      * d.grams / 100.0) AS kcal,
              SUM(f.protein_g * d.grams / 100.0) AS protein_g,
              SUM(f.carbs_g   * d.grams / 100.0) AS carbs_g,
              SUM(f.fat_g     * d.grams / 100.0) AS fat_g
       FROM diary_entries d
       JOIN foods f ON f.id = d.food_id
       WHERE d.user_id = ? AND d.date BETWEEN ? AND ?
       GROUP BY d.date`,
    )
    .all(userId, start, end) as { date: string }[]

  const water = db
    .prepare(
      `SELECT date, SUM(amount_ml) AS total_ml FROM water_entries
       WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date`,
    )
    .all(userId, start, end) as { date: string; total_ml: number }[]

  const workouts = db
    .prepare(
      `SELECT date, SUM(calories) AS calories, SUM(duration_min) AS minutes
       FROM workout_entries
       WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date`,
    )
    .all(userId, start, end) as { date: string }[]

  const weights = db
    .prepare(
      `SELECT date, weight_kg FROM weight_entries
       WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date`,
    )
    .all(userId, start, end) as { date: string; weight_kg: number }[]

  /**
   * Custom measurements, already grouped into one series per type.
   *
   * Grouping here rather than in the client keeps the payload small and means
   * the chart component receives exactly the shape it draws. Types with no
   * readings in the range are left out entirely — an empty chart is worse than
   * no chart.
   */
  const biometricRows = db
    .prepare(
      `SELECT t.id, t.name, t.unit, t.sort_order, b.date, b.value
       FROM biometric_entries b
       JOIN biometric_types t ON t.id = b.type_id
       WHERE b.user_id = ? AND b.date BETWEEN ? AND ?
       ORDER BY t.sort_order, t.id, b.date`,
    )
    .all(userId, start, end) as {
      id: number
      name: string
      unit: string
      date: string
      value: number
    }[]

  const bySeries = new Map<
    number,
    { id: number; name: string; unit: string; points: { date: string; value: number }[] }
  >()
  for (const row of biometricRows) {
    let series = bySeries.get(row.id)
    if (!series) {
      series = { id: row.id, name: row.name, unit: row.unit, points: [] }
      bySeries.set(row.id, series)
    }
    series.points.push({ date: row.date, value: row.value })
  }

  // Index by date so the client can walk the calendar without searching.
  const byDate = (rows: { date: string }[]) =>
    Object.fromEntries(rows.map((r) => [r.date, r]))

  const stored = db.prepare('SELECT * FROM user_goals WHERE user_id = ?').get(userId) as
    | Record<string, unknown>
    | undefined

  const goals = goalScope === 'full'
    ? stored
    : Object.fromEntries(CHART_GOAL_FIELDS.map((key) => [key, stored?.[key] ?? null]))

  return {
    from: start,
    to: end,
    food: byDate(food),
    water: byDate(water),
    workouts: byDate(workouts),
    weights,
    biometrics: [...bySeries.values()],
    goals,
  }
}

import type { DatabaseSync } from 'node:sqlite'
import { addDays } from '#shared/dates'

export type GoalAdjustmentStatus = 'accepted' | 'dismissed'

/**
 * Total kcal logged on each of the 7 days before `beforeDate`, oldest first.
 *
 * A day with no diary entries at all comes back as 0 — same as a day someone
 * only half-logged, and `computeGoalSuggestion` filters both out the same way.
 */
export function weeklyDailyKcals(
  db: DatabaseSync,
  userId: number,
  beforeDate: string,
): number[] {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(beforeDate, i - 7))

  const rows = db
    .prepare(
      `SELECT d.date AS date, SUM(COALESCE(f.kcal, 0) * d.grams / 100.0) AS kcal
       FROM diary_entries d
       JOIN foods f ON f.id = d.food_id
       WHERE d.user_id = ? AND d.date IN (${dates.map(() => '?').join(',')})
       GROUP BY d.date`,
    )
    .all(userId, ...dates) as { date: string; kcal: number }[]

  const byDate = new Map(rows.map((r) => [r.date, r.kcal]))
  return dates.map((d) => byDate.get(d) ?? 0)
}

/** The user's earlier accept/dismiss choice for this day, if any. */
export function getGoalAdjustment(
  db: DatabaseSync,
  userId: number,
  date: string,
): GoalAdjustmentStatus | null {
  const row = db
    .prepare('SELECT status FROM daily_goal_adjustments WHERE user_id = ? AND date = ?')
    .get(userId, date) as { status: GoalAdjustmentStatus } | undefined
  return row?.status ?? null
}

export function setGoalAdjustment(
  db: DatabaseSync,
  userId: number,
  date: string,
  status: GoalAdjustmentStatus,
): void {
  db.prepare(
    `INSERT INTO daily_goal_adjustments (user_id, date, status) VALUES (?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET status = excluded.status`,
  ).run(userId, date, status)
}

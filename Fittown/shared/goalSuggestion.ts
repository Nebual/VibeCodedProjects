/**
 * The "you've been over budget this week" nudge on the diary's Today page.
 *
 * Pure so the threshold logic can be unit-tested without a database — the
 * database side (pulling a week of daily kcal totals, remembering the day's
 * accept/dismiss choice) lives in server/utils/goalSuggestion.ts.
 */

/** A day below this is treated as under-logged, not a light day. */
export const INCOMPLETE_DAY_KCAL_MIN = 1000

/** Need this many *complete* days in the past week before averaging them. */
export const MIN_QUALIFYING_DAYS = 3

/** Only nudge once the week is meaningfully, not marginally, over goal. */
export const OVER_GOAL_THRESHOLD_KCAL = 25

/** How much the suggestion offers to trim off just for today. */
export const GOAL_REDUCTION_KCAL = 100

export interface GoalSuggestion {
  /** Average daily kcal over the qualifying days of the past week. */
  weekly_avg_kcal: number
  /** `calorie_goal` minus `GOAL_REDUCTION_KCAL`. */
  suggested_goal_kcal: number
}

/**
 * `dailyKcals` is the past 7 days' total kcal, oldest first or any order —
 * only the values matter. Days with no logging at all come through as 0 and
 * are filtered out the same as a day someone forgot to finish logging.
 */
export function computeGoalSuggestion(
  dailyKcals: number[],
  calorieGoal: number,
): GoalSuggestion | null {
  const complete = dailyKcals.filter((kcal) => kcal >= INCOMPLETE_DAY_KCAL_MIN)
  if (complete.length < MIN_QUALIFYING_DAYS) return null

  const weeklyAvgKcal = complete.reduce((sum, kcal) => sum + kcal, 0) / complete.length
  if (weeklyAvgKcal <= calorieGoal + OVER_GOAL_THRESHOLD_KCAL) return null

  return {
    weekly_avg_kcal: weeklyAvgKcal,
    suggested_goal_kcal: calorieGoal - GOAL_REDUCTION_KCAL,
  }
}

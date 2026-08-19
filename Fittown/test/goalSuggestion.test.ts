import { describe, expect, it } from 'vitest'
import {
  GOAL_REDUCTION_KCAL,
  INCOMPLETE_DAY_KCAL_MIN,
  MIN_QUALIFYING_DAYS,
  OVER_GOAL_THRESHOLD_KCAL,
  computeGoalSuggestion,
} from '#shared/goalSuggestion'

/**
 * The "lower today's goal?" threshold maths, with no database in sight.
 *
 * These cover the two things that would go quietly wrong: a handful of
 * under-logged days dragging the average down (or up) as if they were real,
 * and a week that's only marginally over goal nagging every day anyway.
 */

const GOAL = 2000

describe('computeGoalSuggestion', () => {
  it('suggests nothing without at least 3 qualifying days', () => {
    expect(computeGoalSuggestion([2500, 2500], GOAL)).toBeNull()
  })

  it('drops days under the incomplete-day floor before averaging', () => {
    // Two real days at 2500, one at 200 (clearly just a coffee, not a diet) —
    // the incomplete day must not count as a low day dragging the average down,
    // nor as one of the 3 required days.
    const dailyKcals = [2500, 2500, 200]
    expect(computeGoalSuggestion(dailyKcals, GOAL)).toBeNull()
  })

  it('treats a day with no logging (0 kcal) the same as an incomplete one', () => {
    expect(computeGoalSuggestion([2500, 2500, 0], GOAL)).toBeNull()
  })

  it('does not suggest when the week is only marginally over goal', () => {
    const justOver = GOAL + OVER_GOAL_THRESHOLD_KCAL
    expect(computeGoalSuggestion([justOver, justOver, justOver], GOAL)).toBeNull()
  })

  it('suggests a 100 kcal cut once the week is meaningfully over goal', () => {
    const dailyKcals = [2400, 2600, 2500]
    const suggestion = computeGoalSuggestion(dailyKcals, GOAL)
    expect(suggestion).not.toBeNull()
    expect(suggestion!.weekly_avg_kcal).toBeCloseTo(2500, 6)
    expect(suggestion!.suggested_goal_kcal).toBe(GOAL - GOAL_REDUCTION_KCAL)
  })

  it('says nothing when the week is under goal', () => {
    expect(computeGoalSuggestion([1500, 1600, 1700], GOAL)).toBeNull()
  })

  it('uses sane constants', () => {
    expect(INCOMPLETE_DAY_KCAL_MIN).toBeGreaterThan(0)
    expect(MIN_QUALIFYING_DAYS).toBeGreaterThanOrEqual(3)
    expect(GOAL_REDUCTION_KCAL).toBeGreaterThan(0)
  })
})

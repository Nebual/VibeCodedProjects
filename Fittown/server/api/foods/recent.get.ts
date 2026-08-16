import { foodCols } from '../../utils/foods'

/**
 * Foods the user logs most, newest-first among equals.
 *
 * This is the highest-value screen in a tracker: most people eat the same
 * thirty things, so surfacing them turns logging into two taps.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { meal } = getQuery(event)

  // When adding to a specific meal, bias towards what they usually eat then.
  const mealFilter = typeof meal === 'string' && MEALS.includes(meal as Meal)
    ? 'AND d.meal = ?'
    : ''
  const params: unknown[] = [user.id]
  if (mealFilter) params.push(meal)

  const results = useDb()
    .prepare(
      `SELECT ${foodCols()},
              COUNT(*) AS times_logged,
              MAX(d.created_at) AS last_logged,
              d.grams AS last_grams,
              d.serving_label AS last_serving_label,
              d.serving_count AS last_serving_count
       FROM diary_entries d
       JOIN foods f ON f.id = d.food_id
       WHERE d.user_id = ? ${mealFilter}
       GROUP BY f.id
       ORDER BY times_logged DESC, last_logged DESC
       LIMIT 40`,
    )
    .all(...params)

  return { results }
})

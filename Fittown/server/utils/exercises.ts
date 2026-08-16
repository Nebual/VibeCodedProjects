import type { DatabaseSync } from 'node:sqlite'

/**
 * Columns every exercise list returns.
 *
 * Table-qualified, so any query using this needs `FROM exercises e` — both
 * `exercises` and `workout_entries` have `id` and `created_at`, and an
 * unqualified list would be ambiguous or silently pick the wrong one.
 */
export function exerciseCols(): string {
  return `e.id, e.name, e.category, e.met, e.met_light, e.met_hard,
          e.tracks_sets, e.tracks_distance, e.hint, e.owner_user_id,
          (SELECT GROUP_CONCAT(c.category) FROM exercise_categories c
            WHERE c.exercise_id = e.id) AS categories`
}

/** Turn the GROUP_CONCAT of categories back into an array. */
export function withCategories(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    ...row,
    categories: typeof row.categories === 'string' ? row.categories.split(',') : [],
  }))
}

/**
 * The activities this user logged most recently, most recent first.
 *
 * Most people cycle through the same handful of activities, so putting them a
 * tap away is worth more than any amount of browsing. Unlike the food
 * equivalent — which ranks by how *often* something is eaten — this ranks
 * purely by recency: training goes in phases, and the block you're in now
 * matters more than the one you finished in March.
 *
 * Ordered by `MAX(w.id)` rather than a timestamp. `date` is the day the
 * workout happened, which back-dating makes a poor proxy for "what I just
 * used", and `created_at` only has second precision so it ties constantly.
 * The row id is monotonic and answers the actual question: what did this
 * person log last.
 */
export function recentExercises(
  db: DatabaseSync,
  userId: number,
  limit = 10,
): Record<string, unknown>[] {
  const rows = db
    .prepare(
      `SELECT ${exerciseCols()}, MAX(w.id) AS last_logged_id
       FROM workout_entries w
       JOIN exercises e ON e.id = w.exercise_id
       WHERE w.user_id = ?
       GROUP BY e.id
       ORDER BY last_logged_id DESC
       LIMIT ?`,
    )
    .all(userId, limit) as Record<string, unknown>[]

  // `last_logged_id` is an ordering detail; the client gets the same shape as
  // every other exercise list so one component can render either.
  return withCategories(rows).map(({ last_logged_id: _ignored, ...rest }) => rest)
}

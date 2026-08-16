import { exerciseCols, withCategories } from '../../utils/exercises'

/**
 * Exercise library: shared activities plus the caller's own additions.
 *
 * Accepts either a search term or a category, since the fitness page offers
 * both routes in — browse the category grid, or type past it.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { q, category } = getQuery(event)
  const text = typeof q === 'string' ? q.trim() : ''
  const cat = typeof category === 'string' ? category.trim() : ''

  const where = ['(e.owner_user_id IS NULL OR e.owner_user_id = ?)']
  const params: unknown[] = [user.id]

  if (text) {
    where.push('e.name LIKE ?')
    params.push(`%${text}%`)
  }

  if (cat) {
    // Custom exercises have no category rows, so they'd vanish from every
    // category. Showing them under their own `category` column keeps them
    // reachable by browsing rather than search alone.
    where.push(
      `(EXISTS (SELECT 1 FROM exercise_categories c
                WHERE c.exercise_id = e.id AND c.category = ?)
        OR (e.owner_user_id IS NOT NULL AND e.category = ?))`,
    )
    params.push(cat, cat)
  }

  const results = useDb()
    .prepare(
      `SELECT ${exerciseCols()}
       FROM exercises e
       WHERE ${where.join(' AND ')}
       ORDER BY (e.owner_user_id IS NOT NULL) DESC, e.name
       LIMIT 200`,
    )
    .all(...params) as Record<string, unknown>[]

  return { results: withCategories(results) }
})

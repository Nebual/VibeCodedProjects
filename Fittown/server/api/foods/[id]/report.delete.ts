/**
 * Undo a "report as inaccurate", unhiding the food.
 *
 * Anyone who can reach the food's own page may clear the report — a reported
 * food is still openable by its direct URL, and the Undo button lives right
 * there. The food can always be reported again, so handing undo to whoever is
 * looking at it is the household's way to bring a wrongly-flagged product back.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'food id')

  const db = useDb()
  const food = db
    .prepare('SELECT id, reported_by FROM foods WHERE id = ?')
    .get(id) as { id: number; reported_by: number | null } | undefined

  if (!food) throw createError({ statusCode: 404, statusMessage: 'Food not found' })

  if (food.reported_by === null) {
    // Nothing reported; unhiding an un-hidden food is a no-op, not an error.
    return { reported_by: null }
  }

  db.prepare('UPDATE foods SET reported_by = NULL WHERE id = ?').run(id)

  return { reported_by: null }
})
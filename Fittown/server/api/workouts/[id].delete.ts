/**
 * Delete a workout. For a device-synced row this has to mean more than
 * removing it here — without recording that, the next sync would just
 * re-import it, since the sync payload has no way to know a row it's about
 * to send was deliberately removed. docs/samsung-health-sync.md §4.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'workout id')

  const db = useDb()

  const workout = db
    .prepare('SELECT source, external_id FROM workout_entries WHERE id = ? AND user_id = ?')
    .get(id, user.id) as { source: string; external_id: string | null } | undefined

  if (!workout) {
    throw createError({ statusCode: 404, statusMessage: 'Workout not found' })
  }

  if (workout.source === 'health_connect' && workout.external_id) {
    db.prepare(
      `INSERT INTO health_ignored (user_id, external_id) VALUES (?, ?)
       ON CONFLICT(user_id, external_id) DO NOTHING`,
    ).run(user.id, workout.external_id)
  }

  db.prepare('DELETE FROM workout_entries WHERE id = ? AND user_id = ?').run(id, user.id)

  return { ok: true }
})

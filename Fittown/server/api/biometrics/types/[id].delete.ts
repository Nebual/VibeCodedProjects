/**
 * Stop tracking a measurement.
 *
 * Its readings go with it (ON DELETE CASCADE) — a measurement type with no
 * type is meaningless, and leaving orphaned numbers around would be worse than
 * removing them. The UI warns before calling this.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'))

  useDb()
    .prepare('DELETE FROM biometric_types WHERE id = ? AND user_id = ?')
    .run(id, user.id)

  return { ok: true }
})

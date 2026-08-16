export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'workout id')

  const info = useDb()
    .prepare('DELETE FROM workout_entries WHERE id = ? AND user_id = ?')
    .run(id, user.id)

  if (info.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Workout not found' })
  }
  return { ok: true }
})

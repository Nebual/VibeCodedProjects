export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'entry id')

  // Scoped by user_id so an id guessed from another account is a no-op.
  const info = useDb()
    .prepare('DELETE FROM diary_entries WHERE id = ? AND user_id = ?')
    .run(id, user.id)

  if (info.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Entry not found' })
  }
  return { ok: true }
})

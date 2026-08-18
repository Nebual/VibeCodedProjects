import { deleteRecipeLog } from '../../../utils/recipes'

/**
 * Remove an entry, and the frozen recipe behind it if there is one.
 *
 * Order matters and is not negotiable: `diary_entries.food_id` is ON DELETE
 * RESTRICT, so the snapshot can only go once nothing points at it. Both in one
 * transaction, or a failure halfway leaves an orphan food row that nothing will
 * ever clean up.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'entry id')

  return transact((db) => {
    // Scoped by user_id so an id guessed from another account is a no-op.
    const entry = db
      .prepare('SELECT food_id FROM diary_entries WHERE id = ? AND user_id = ?')
      .get(id, user.id) as { food_id: number } | undefined

    if (!entry) throw createError({ statusCode: 404, statusMessage: 'Entry not found' })

    db.prepare('DELETE FROM diary_entries WHERE id = ? AND user_id = ?').run(id, user.id)
    // Refuses anything that isn't this user's frozen copy, so a plain food is
    // never at risk from being handed to it.
    deleteRecipeLog(db, entry.food_id, user.id)

    return { ok: true }
  })
})

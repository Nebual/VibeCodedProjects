/**
 * Stop sharing a recipe.
 *
 * Revoked rather than deleted, so the unique "one live link per recipe" index
 * still lets a new link be made later, and so an old link can be told apart
 * from a token that never existed.
 *
 * Copies other people already took are their own rows and are unaffected —
 * this closes the door, it doesn't reach through it.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'recipe id')

  const info = useDb()
    .prepare(
      `UPDATE recipe_shares SET revoked_at = datetime('now')
       WHERE food_id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
    )
    .run(id, user.id)

  if (info.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'That recipe isn’t shared' })
  }

  return { ok: true }
})

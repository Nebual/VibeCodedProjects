import { recipeDetail } from '../../utils/recipes'

/**
 * One recipe, with everything the editor draws: the ingredients, what each of
 * them contributes, and the totals for the whole recipe and for one serving.
 *
 * The assembly lives in `server/utils/recipes.ts` so the read-only views — a
 * friend's copy and a public share link — show exactly the same numbers.
 *
 * `share` is the live public link for this recipe, if the owner has made one.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'recipe id')

  const db = useDb()
  const detail = recipeDetail(db, id, user.id)
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

  const share = db
    .prepare(
      'SELECT token, created_at FROM recipe_shares WHERE food_id = ? AND revoked_at IS NULL',
    )
    .get(id) as { token: string; created_at: string } | undefined

  return { ...detail, share: share ?? null }
})

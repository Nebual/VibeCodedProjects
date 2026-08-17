import { findRecipe } from '../../../utils/recipes'
import { newToken } from '../../../utils/friends'

/**
 * Publish a recipe as a link anyone can open.
 *
 * Independent of friends on purpose: sending a recipe to someone who doesn't
 * use Fittown is the common case, and requiring an account first would make
 * the link useless for it.
 *
 * Idempotent. `idx_recipe_shares_live` allows one live row per recipe, so
 * pressing Share twice hands back the same URL rather than minting a second
 * token the user can see no trace of and can never revoke.
 *
 * Returns the token; the page builds the URL from its own origin (see the
 * invite route for why that beats deriving it from request headers).
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'recipe id')

  return transact((db) => {
    const recipe = findRecipe(db, id, user.id)
    if (!recipe) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

    const existing = db
      .prepare(
        'SELECT token, created_at FROM recipe_shares WHERE food_id = ? AND revoked_at IS NULL',
      )
      .get(id) as { token: string; created_at: string } | undefined

    if (existing) return { share: existing, created: false }

    const token = newToken()
    db.prepare(
      'INSERT INTO recipe_shares (token, food_id, owner_user_id) VALUES (?, ?, ?)',
    ).run(token, id, user.id)

    const share = db
      .prepare('SELECT token, created_at FROM recipe_shares WHERE token = ?')
      .get(token)

    return { share, created: true }
  })
})

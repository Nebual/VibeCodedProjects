import { friendDisplayName, isShareToken } from '#shared/friends'
import { recipeDetail } from '../../../utils/recipes'

/**
 * A shared recipe, readable without signing in.
 *
 * The only route in the app that answers without `requireUser()`. It is safe to
 * because it is keyed by an unguessable token the owner minted deliberately,
 * and because it returns one recipe and a display name — no ids that address
 * anything else, no email, nothing about a diary.
 *
 * A revoked link 410s rather than 404s: "the owner stopped sharing this" is a
 * different thing to know than "that URL is wrong", and the person holding the
 * link has been told the truth either way.
 */
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (!isShareToken(token)) {
    throw createError({ statusCode: 404, statusMessage: 'No such recipe link' })
  }

  const db = useDb()
  const share = db
    .prepare(
      `SELECT s.food_id, s.owner_user_id, s.revoked_at, u.name, u.email
       FROM recipe_shares s
       JOIN users u ON u.id = s.owner_user_id
       WHERE s.token = ?`,
    )
    .get(token) as
    | {
        food_id: number
        owner_user_id: number
        revoked_at: string | null
        name: string
        email: string
      }
    | undefined

  if (!share) throw createError({ statusCode: 404, statusMessage: 'No such recipe link' })
  if (share.revoked_at) {
    throw createError({ statusCode: 410, statusMessage: 'This recipe is no longer shared' })
  }

  const detail = recipeDetail(db, share.food_id, share.owner_user_id)
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'No such recipe link' })

  // The owner's user id rides along on every food row and is of no use to a
  // stranger — nothing is addressable by it without an accepted friendship —
  // so it comes off here rather than being published for no reason.
  const { owner_user_id: _ownerId, ...recipe } = detail.recipe

  return {
    ...detail,
    recipe,
    owner: { name: friendDisplayName({ name: share.name, email: share.email }) },
  }
})

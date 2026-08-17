import { acceptFriendship } from '../../../utils/friends'

/**
 * Accept a friend request.
 *
 * Scoped to the addressee inside `acceptFriendship()`, so a guessed id is a
 * no-op rather than a way to befriend yourself to someone.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'request id')

  if (!acceptFriendship(useDb(), id, user.id)) {
    throw createError({ statusCode: 404, statusMessage: 'No such request' })
  }

  return { ok: true }
})

import { removeFriendship } from '../../../utils/friends'

/**
 * Decline a request, cancel one you sent, or end a friendship.
 *
 * All three are the same row being deleted, and either party may do it in any
 * state — declining an unwanted request and ending a friendship are the same
 * wish. Nothing is copied back: recipes the two of them copied from each other
 * are their own rows and stay put.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'request id')

  if (!removeFriendship(useDb(), id, user.id)) {
    throw createError({ statusCode: 404, statusMessage: 'No such request' })
  }

  return { ok: true }
})

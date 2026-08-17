import { listIncoming } from '../../utils/friends'

/**
 * Just the requests waiting on an answer.
 *
 * Behind the accept prompt in the layout, which asks on every page load and
 * then every few minutes. Kept separate from `/api/friends` so that poll costs
 * one small indexed query rather than four lists nobody is looking at.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { incoming: listIncoming(useDb(), user.id) }
})

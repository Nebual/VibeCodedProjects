import { friendPermissions, requireFriendship } from '../../../utils/friends'

/**
 * Who this friend is and what they've chosen to share.
 *
 * The friend page asks for this first so it can draw the right sections rather
 * than firing four requests and rendering three refusals.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'friend id')

  const db = useDb()
  const friend = requireFriendship(db, user.id, id)

  return { friend, permissions: friendPermissions(db, id) }
})

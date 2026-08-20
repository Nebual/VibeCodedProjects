import { requireSharedSection } from '../../../utils/friends'
import { listCustomFoods } from '../../../utils/foods'

/**
 * A friend's custom foods — the same library they see in their own food search,
 * if they share it.
 *
 * Read-only list for browsing and for the copy buttons; the mutations go through
 * the copy route, which carries its own gate. This route's only job is to hand a
 * friend who opted in the rows they opted into.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'friend id')

  const db = useDb()
  const { friend } = requireSharedSection(db, user.id, id, 'share_custom_foods')

  return { friend, foods: listCustomFoods(db, id) }
})
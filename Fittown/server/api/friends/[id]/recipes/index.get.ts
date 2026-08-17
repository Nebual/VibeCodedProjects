import { requireSharedSection } from '../../../../utils/friends'
import { listRecipeSummaries } from '../../../../utils/recipes'

/** A friend's recipes — the same list as your own, if they share them. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'friend id')

  const db = useDb()
  const { friend } = requireSharedSection(db, user.id, id, 'share_recipes')

  return { friend, recipes: listRecipeSummaries(db, id) }
})

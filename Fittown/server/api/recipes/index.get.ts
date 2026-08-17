import { listRecipeSummaries } from '../../utils/recipes'

/**
 * The user's recipes, for the recipe list and the Recipes tab on /add.
 *
 * The query lives in `server/utils/recipes.ts` because a friend's recipe list
 * (`/api/friends/[id]/recipes`) is the same list of the same shape.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { recipes: listRecipeSummaries(useDb(), user.id) }
})

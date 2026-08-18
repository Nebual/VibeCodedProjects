import { ancestorIds, listRecipeSummaries } from '../../utils/recipes'

/**
 * The user's recipes, for the recipe list and the Recipes tab on /add.
 *
 * The query lives in `server/utils/recipes.ts` because a friend's recipe list
 * (`/api/friends/[id]/recipes`) is the same list of the same shape.
 *
 * `for_recipe` narrows it to the recipes that may be nested inside that one:
 * everything except itself and anything that already contains it. The same rule
 * `/api/foods/search` applies, because the Recipes tab and the search results
 * sit on the same screen and must not disagree about what can be picked.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()

  const id = Number(getQuery(event).for_recipe)
  const recipes = listRecipeSummaries(db, user.id)
  if (!Number.isInteger(id) || id <= 0) return { recipes }

  const forbidden = new Set([id, ...ancestorIds(db, id)])
  return { recipes: recipes.filter((recipe) => !forbidden.has(Number(recipe.id))) }
})

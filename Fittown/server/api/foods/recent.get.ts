import { listFrequentFoods } from '../../utils/foods'
import { ancestorIds } from '../../utils/recipes'

/**
 * Foods the user logs most, newest-first among equals.
 *
 * This is the highest-value screen in a tracker: most people eat the same
 * thirty things, so surfacing them turns logging into two taps.
 *
 * The query lives in `server/utils/foods.ts` — it has to see through a frozen
 * meal to the recipe it was logged from, which is worth a test.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { meal, for_recipe: forRecipe } = getQuery(event)
  const db = useDb()

  // When adding to a specific meal, bias towards what they usually eat then.
  const forMeal = typeof meal === 'string' && MEALS.includes(meal as Meal) ? meal : null

  // Picking an ingredient: leave out the recipe itself and anything that
  // already contains it, exactly as the search and the Recipes tab do.
  const recipeId = Number(forRecipe)
  const exclude = Number.isInteger(recipeId) && recipeId > 0
    ? [recipeId, ...ancestorIds(db, recipeId)]
    : []

  return { results: listFrequentFoods(db, user.id, forMeal, 40, exclude) }
})

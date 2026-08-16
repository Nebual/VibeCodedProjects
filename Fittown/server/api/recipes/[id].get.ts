import { scaleNutrients } from '#shared/nutrients'
import { rollUpRecipe } from '#shared/recipes'
import { findRecipe, listIngredients } from '../../utils/recipes'

/**
 * One recipe, with everything the editor draws: the ingredients, what each of
 * them contributes, and the totals for the whole recipe and for one serving.
 *
 * The totals are recomputed here rather than read back off the food row so the
 * editor shows the same arithmetic the recompute will store — if the two ever
 * disagreed, this is the screen where it would be visible.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'recipe id')

  const db = useDb()
  const recipe = findRecipe(db, id, user.id)
  if (!recipe) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

  const ingredients = listIngredients(db, id)
  const rollUp = rollUpRecipe(ingredients, recipe.recipe_final_weight_g)

  const servings = recipe.recipe_servings && recipe.recipe_servings > 0
    ? recipe.recipe_servings
    : 1

  const perServing: Record<string, number> = {}
  for (const [key, value] of Object.entries(rollUp.totals)) {
    if (value !== null) perServing[key] = value / servings
  }

  // Absent nutrients are dropped rather than sent as null, matching what
  // scaleNutrients() does for a diary entry — the UI renders a missing key as
  // "not recorded" and a zero as a real measurement.
  const totals: Record<string, number> = {}
  for (const [key, value] of Object.entries(rollUp.totals)) {
    if (value !== null) totals[key] = value
  }

  return {
    recipe,
    ingredients: ingredients.map((ingredient) => ({
      id: ingredient.id,
      grams: ingredient.grams,
      serving_label: ingredient.serving_label,
      serving_count: ingredient.serving_count,
      sort_order: ingredient.sort_order,
      food: ingredient.food,
      nutrients: scaleNutrients(ingredient.food, ingredient.grams),
    })),
    raw_g: rollUp.raw_g,
    basis_g: rollUp.basis_g,
    totals,
    per_serving: perServing,
  }
})

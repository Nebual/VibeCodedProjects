import { RECIPE_SOURCE } from '#shared/recipes'

/**
 * The user's recipes, for the recipe list and the Recipes tab on /add.
 *
 * Deliberately not the full food rows: this screen shows a name, a serving
 * count and an energy figure, and a recipe row carries forty nutrient columns.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)

  const rows = useDb()
    .prepare(
      // `source` and `brand` come along because the Recipes tab on /add feeds
      // these rows straight into FoodResultList, which needs them to know it is
      // looking at a recipe — and therefore whether it may quote a weight.
      `SELECT f.id, f.name, f.source, f.brand, f.is_liquid,
              f.recipe_servings, f.recipe_final_weight_g,
              f.serving_grams, f.kcal,
              (SELECT COUNT(*) FROM recipe_ingredients ri
               WHERE ri.recipe_food_id = f.id) AS ingredient_count
       FROM foods f
       WHERE f.owner_user_id = ? AND f.source = ?
       ORDER BY f.name COLLATE NOCASE`,
    )
    .all(user.id, RECIPE_SOURCE) as (Record<string, unknown> & {
      kcal: number | null
      serving_grams: number | null
    })[]

  return {
    recipes: rows.map((row) => ({
      ...row,
      // Energy for one serving — the number the list is actually read for.
      // Null when the recipe is still empty, which is not the same as zero.
      kcal_per_serving:
        row.kcal !== null && row.serving_grams !== null
          ? (row.kcal * row.serving_grams) / 100
          : null,
    })),
  }
})

import type { NutrientTotals } from '#shared/nutrients'
import type { FoodRow } from '~/composables/useDiary'

/** A row in the recipe list — deliberately not the forty-column food row. */
export interface RecipeSummary {
  id: number
  name: string
  /** Always 'recipe'. Carried so this row can be handed to FoodResultList. */
  source: string
  brand: string | null
  is_liquid: number
  recipe_servings: number | null
  recipe_final_weight_g: number | null
  serving_grams: number | null
  kcal: number | null
  ingredient_count: number
  /** Null when the recipe is still empty — which is not the same as zero. */
  kcal_per_serving: number | null
}

export interface RecipeIngredient {
  id: number
  grams: number
  serving_label: string | null
  serving_count: number | null
  sort_order: number
  food: FoodRow
  /** What this ingredient contributes, already scaled to its amount. */
  nutrients: NutrientTotals
}

export interface RecipeDetail {
  recipe: FoodRow
  ingredients: RecipeIngredient[]
  /** What went into the mixture. */
  raw_g: number
  /** What the portion maths divides by: the yield if stated, else `raw_g`. */
  basis_g: number
  totals: NutrientTotals
  per_serving: NutrientTotals
  /** The live public link for this recipe, if its owner made one. */
  share?: { token: string; created_at: string } | null
}

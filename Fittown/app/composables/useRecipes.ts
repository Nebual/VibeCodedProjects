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
  /** Imported lines still waiting for a food to be attached. */
  unresolved_count: number
  /** Null when the recipe is still empty — which is not the same as zero. */
  kcal_per_serving: number | null
  /** Variants share this. A recipe with none is a family of one. */
  family_id: number
  /** How many *other* recipes are in that family. */
  variant_count: number
}

/** A sibling recipe, as the variants strip draws it. */
export interface RecipeVariant {
  id: number
  name: string
  kcal_per_serving: number | null
}

export interface RecipeIngredient {
  id: number
  grams: number
  serving_label: string | null
  serving_count: number | null
  /** The line as pasted or scraped. Null on ingredients added by hand. */
  raw_text: string | null
  /** Amount descriptor or prep note — "a lot of", "minced". */
  note: string | null
  /** The arithmetic the amount was typed as — for the input box only. */
  amount_formula: string | null
  sort_order: number
  /** Does this ingredient get a switch — "50 g bacon on top"? */
  is_optional: number
  /** Is it counted? A switched-off optional is in the recipe but not in it. */
  is_included: number
  /**
   * Null when an import couldn't match this line to a food. Such a row has no
   * nutrition and no weight; `raw_text` is the only name it has.
   */
  food: FoodRow | null
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
  /** How many ingredients the totals below are *not* counting. */
  unresolved_count: number
  totals: NutrientTotals
  per_serving: NutrientTotals
  /** The live public link for this recipe, if its owner made one. */
  share?: { token: string; created_at: string } | null
  /** Which family this recipe belongs to — its own id when it has no variants. */
  family_id?: number
  /** The other recipes in that family. Empty for a frozen meal. */
  variants?: RecipeVariant[]
}

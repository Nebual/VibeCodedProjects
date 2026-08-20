/**
 * Canonical nutrient catalogue, shared by the server and the UI.
 *
 * Keys match `foods` table columns exactly, so a food row can be treated as a
 * nutrient vector without any mapping layer.
 */

export type NutrientGroup = 'macro' | 'mineral' | 'vitamin' | 'other'

export interface NutrientDef {
  key: string
  label: string
  unit: string
  group: NutrientGroup
  /** Reference daily intake for an adult, used for the % bars. */
  rda?: number
  /** Nutrients you want to stay *under* render as a budget, not a target. */
  limit?: boolean
  decimals: number
}

/**
 * Reference values are US Daily Values (FDA, adults & children 4+). They're a
 * reasonable one-size default; per-user overrides live in `user_goals` for the
 * handful that people actually tune (calories and the four macros).
 */
export const NUTRIENTS: NutrientDef[] = [
  // Macros
  { key: 'kcal', label: 'Energy', unit: 'kcal', group: 'macro', decimals: 0 },
  { key: 'protein_g', label: 'Protein', unit: 'g', group: 'macro', rda: 50, decimals: 1 },
  { key: 'carbs_g', label: 'Carbs', unit: 'g', group: 'macro', rda: 275, decimals: 1 },
  { key: 'fat_g', label: 'Fat', unit: 'g', group: 'macro', rda: 78, decimals: 1 },
  { key: 'fiber_g', label: 'Fibre', unit: 'g', group: 'macro', rda: 28, decimals: 1 },
  { key: 'sugars_g', label: 'Sugars', unit: 'g', group: 'macro', decimals: 1 },
  { key: 'added_sugars_g', label: 'Added sugars', unit: 'g', group: 'macro', rda: 50, limit: true, decimals: 1 },
  { key: 'sugar_alcohols_g', label: 'Sugar alcohols', unit: 'g', group: 'macro', decimals: 1 },
  { key: 'sat_fat_g', label: 'Saturated fat', unit: 'g', group: 'macro', rda: 20, limit: true, decimals: 1 },
  { key: 'trans_fat_g', label: 'Trans fat', unit: 'g', group: 'macro', decimals: 2 },
  { key: 'mono_fat_g', label: 'Monounsaturated', unit: 'g', group: 'macro', decimals: 1 },
  { key: 'poly_fat_g', label: 'Polyunsaturated', unit: 'g', group: 'macro', decimals: 1 },
  { key: 'omega3_g', label: 'Omega-3', unit: 'g', group: 'macro', decimals: 2 },
  { key: 'cholesterol_mg', label: 'Cholesterol', unit: 'mg', group: 'macro', rda: 300, limit: true, decimals: 0 },

  // Minerals
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg', group: 'mineral', rda: 2300, limit: true, decimals: 0 },
  { key: 'potassium_mg', label: 'Potassium', unit: 'mg', group: 'mineral', rda: 4700, decimals: 0 },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', group: 'mineral', rda: 1300, decimals: 0 },
  { key: 'iron_mg', label: 'Iron', unit: 'mg', group: 'mineral', rda: 18, decimals: 1 },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', group: 'mineral', rda: 420, decimals: 0 },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg', group: 'mineral', rda: 11, decimals: 1 },
  { key: 'phosphorus_mg', label: 'Phosphorus', unit: 'mg', group: 'mineral', rda: 1250, decimals: 0 },
  { key: 'copper_mg', label: 'Copper', unit: 'mg', group: 'mineral', rda: 0.9, decimals: 2 },
  { key: 'manganese_mg', label: 'Manganese', unit: 'mg', group: 'mineral', rda: 2.3, decimals: 2 },
  { key: 'selenium_ug', label: 'Selenium', unit: 'µg', group: 'mineral', rda: 55, decimals: 1 },
  { key: 'iodine_ug', label: 'Iodine', unit: 'µg', group: 'mineral', rda: 150, decimals: 0 },

  // Vitamins
  { key: 'vit_a_ug', label: 'Vitamin A', unit: 'µg', group: 'vitamin', rda: 900, decimals: 0 },
  { key: 'vit_c_mg', label: 'Vitamin C', unit: 'mg', group: 'vitamin', rda: 90, decimals: 1 },
  { key: 'vit_d_ug', label: 'Vitamin D', unit: 'µg', group: 'vitamin', rda: 20, decimals: 1 },
  { key: 'vit_e_mg', label: 'Vitamin E', unit: 'mg', group: 'vitamin', rda: 15, decimals: 1 },
  { key: 'vit_k_ug', label: 'Vitamin K', unit: 'µg', group: 'vitamin', rda: 120, decimals: 0 },
  { key: 'vit_b1_mg', label: 'Thiamin (B1)', unit: 'mg', group: 'vitamin', rda: 1.2, decimals: 2 },
  { key: 'vit_b2_mg', label: 'Riboflavin (B2)', unit: 'mg', group: 'vitamin', rda: 1.3, decimals: 2 },
  { key: 'vit_b3_mg', label: 'Niacin (B3)', unit: 'mg', group: 'vitamin', rda: 16, decimals: 1 },
  { key: 'vit_b6_mg', label: 'Vitamin B6', unit: 'mg', group: 'vitamin', rda: 1.7, decimals: 2 },
  { key: 'folate_ug', label: 'Folate', unit: 'µg', group: 'vitamin', rda: 400, decimals: 0 },
  { key: 'vit_b12_ug', label: 'Vitamin B12', unit: 'µg', group: 'vitamin', rda: 2.4, decimals: 1 },

  // Other
  { key: 'caffeine_mg', label: 'Caffeine', unit: 'mg', group: 'other', decimals: 0 },
  { key: 'alcohol_g', label: 'Alcohol', unit: 'g', group: 'other', decimals: 1 },
  { key: 'water_g', label: 'Water', unit: 'g', group: 'other', decimals: 0 },
]

export const NUTRIENT_KEYS = NUTRIENTS.map((n) => n.key)
export const NUTRIENT_BY_KEY = new Map(NUTRIENTS.map((n) => [n.key, n]))

/** The macros the diary and the breakdown lead with, in display order (Fat, Carbs, Protein). */
export const HEADLINE_MACROS = ['fat_g', 'carbs_g', 'protein_g'] as const

export type NutrientTotals = Record<string, number>

/**
 * Scale a food's per-100g nutrient vector to an actual portion.
 *
 * Nulls are preserved as "absent" rather than zero: a food with no recorded
 * iron shouldn't drag a day's iron total down as though it contained none.
 */
export function scaleNutrients(
  food: Record<string, unknown>,
  grams: number,
): NutrientTotals {
  const factor = grams / 100
  const out: NutrientTotals = {}
  for (const key of NUTRIENT_KEYS) {
    const value = food[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value * factor
    }
  }
  return out
}

/** Sum nutrient vectors, skipping absent values. */
export function sumNutrients(vectors: NutrientTotals[]): NutrientTotals {
  const out: NutrientTotals = {}
  for (const vec of vectors) {
    for (const key in vec) {
      out[key] = (out[key] ?? 0) + vec[key]!
    }
  }
  return out
}

/** Format a nutrient value using its catalogue precision. */
export function formatNutrient(key: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–'
  const def = NUTRIENT_BY_KEY.get(key)
  return value.toFixed(def?.decimals ?? 1)
}

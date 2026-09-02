import type { RecipeAdjustment } from '#shared/recipes'

/**
 * Validate a meal's adjustments off the wire.
 *
 * Its own module because two diary routes need it and neither owns it. Every
 * field goes through the same validators the rest of the API uses, so a hostile
 * body can't reach `cloneRecipe()` with a string where a number should be.
 *
 * An empty or absent list is legal and means "as written" — the overwhelmingly
 * common case, and the one that must stay free of ceremony.
 */
export function assertAdjustments(value: unknown): RecipeAdjustment[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: 'adjustments must be an array' })
  }
  // A runaway guard, not a rule: a recipe holds at most MAX_INGREDIENTS lines,
  // and a meal can change each of them once and add a few.
  if (value.length > 200) {
    throw createError({ statusCode: 400, statusMessage: 'Too many adjustments' })
  }

  return value.map((raw, index) => {
    const entry = raw as Record<string, unknown>
    const where = `adjustments[${index}]`

    if (entry.op === 'add') {
      return {
        op: 'add' as const,
        food_id: assertId(entry.food_id, `${where}.food_id`),
        grams: assertNumber(entry.grams, `${where}.grams`, { min: 0, max: 20000 }),
        serving_label: optionalText(entry.serving_label, 60),
        serving_count: optionalNumber(entry.serving_count, `${where}.serving_count`, {
          min: 0.01,
          max: 1000,
        }),
        amount_formula: optionalText(entry.amount_formula, 100),
      }
    }

    if (entry.op !== 'set') {
      throw createError({ statusCode: 400, statusMessage: `${where}.op must be 'set' or 'add'` })
    }

    return {
      op: 'set' as const,
      ingredient_id: assertId(entry.ingredient_id, `${where}.ingredient_id`),
      // Zero is a real amount — see the schema note on recipe_ingredients.grams.
      grams: entry.grams === undefined
        ? undefined
        : assertNumber(entry.grams, `${where}.grams`, { min: 0, max: 20000 }),
      included: entry.included === undefined ? undefined : Boolean(entry.included),
      food_id: entry.food_id === undefined
        ? undefined
        : assertId(entry.food_id, `${where}.food_id`),
      serving_label: entry.serving_label === undefined
        ? undefined
        : optionalText(entry.serving_label, 60),
      serving_count: entry.serving_count === undefined
        ? undefined
        : optionalNumber(entry.serving_count, `${where}.serving_count`, { min: 0.01, max: 1000 }),
      amount_formula: entry.amount_formula === undefined
        ? undefined
        : optionalText(entry.amount_formula, 100),
    }
  })
}

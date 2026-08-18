import { describe, expect, it } from 'vitest'
import {
  RECIPE_SOURCE,
  WHOLE_RECIPE_LABEL,
  isRecipe,
  needsWholeRecipeOption,
  recipeBasisGrams,
  recipeServingGrams,
  recipeServingLabel,
  rollUpRecipe,
  showsGramPortions,
  isRecipeLog,
  RECIPE_LOG_SOURCE,
} from '#shared/recipes'

/**
 * The recipe maths, with no database in sight.
 *
 * These cover the three things that would go quietly wrong: a cooked yield
 * changing nutrition it can't change, a partly-recorded nutrient being shown
 * as zero instead of absent, and gram portions being offered for a dish
 * nobody weighed.
 */

/** A food row as the database hands it over: per 100 g, nulls for unknowns. */
function food(values: Record<string, number | null>) {
  return values as Record<string, unknown>
}

const chicken = food({ kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6, iron_mg: 1 })
const rice = food({ kcal: 130, protein_g: 2.7, carbs_g: 28, fat_g: 0.3, iron_mg: 0.2 })
/** Plenty of Open Food Facts rows look like this: macros only. */
const oil = food({ kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100, iron_mg: null })

describe('basis weight', () => {
  it('falls back to the raw ingredient sum when no yield is stated', () => {
    expect(recipeBasisGrams(500, null)).toBe(500)
    expect(recipeBasisGrams(500, undefined)).toBe(500)
  })

  it('prefers the stated yield', () => {
    expect(recipeBasisGrams(500, 420)).toBe(420)
  })

  it('ignores a nonsense yield rather than dividing by it', () => {
    expect(recipeBasisGrams(500, 0)).toBe(500)
    expect(recipeBasisGrams(500, -10)).toBe(500)
  })

  it('gives an empty recipe no weight, even with a yield typed in', () => {
    // Otherwise deleting the last ingredient from a recipe someone had already
    // weighed leaves a serving size behind with no nutrition under it, and the
    // diary logs a portion worth nothing.
    expect(recipeBasisGrams(0, 400)).toBe(0)
    expect(recipeServingGrams(recipeBasisGrams(0, 400), 4)).toBeNull()
  })
})

describe('rolling ingredients up', () => {
  const ingredients = [
    { grams: 200, food: chicken },
    { grams: 300, food: rice },
  ]

  it('totals each nutrient over the mixture', () => {
    const { totals, raw_g: rawG } = rollUpRecipe(ingredients)
    expect(rawG).toBe(500)
    // 165 kcal/100g × 200 g + 130 kcal/100g × 300 g
    expect(totals.kcal).toBeCloseTo(330 + 390, 6)
    expect(totals.protein_g).toBeCloseTo(62 + 8.1, 6)
  })

  it('spreads the totals over the basis weight', () => {
    const { per100 } = rollUpRecipe(ingredients)
    expect(per100.kcal).toBeCloseTo((720 / 500) * 100, 6)
  })

  it('lets a cooked yield concentrate the per-100g figures', () => {
    const loose = rollUpRecipe(ingredients)
    const reduced = rollUpRecipe(ingredients, 400)

    // Water left the pan; the same food is now denser.
    expect(reduced.per100.kcal!).toBeGreaterThan(loose.per100.kcal!)
    expect(reduced.per100.kcal).toBeCloseTo((720 / 400) * 100, 6)
  })

  it('never lets a stated yield change what the recipe contains', () => {
    // The property the whole feature leans on: weighing the pan cannot create
    // or destroy calories, so servings stay correct with or without a yield.
    const loose = rollUpRecipe(ingredients)
    const reduced = rollUpRecipe(ingredients, 400)
    expect(reduced.totals.kcal).toBeCloseTo(loose.totals.kcal!, 9)
    expect(reduced.totals.protein_g).toBeCloseTo(loose.totals.protein_g!, 9)
  })

  it('returns nulls, not zeroes, for an empty recipe', () => {
    const empty = rollUpRecipe([])
    expect(empty.raw_g).toBe(0)
    expect(empty.totals.kcal).toBeNull()
    expect(empty.per100.kcal).toBeNull()
  })

  it('ignores ingredients with no weight', () => {
    const { raw_g: rawG, totals } = rollUpRecipe([
      { grams: 200, food: chicken },
      { grams: 0, food: rice },
    ])
    expect(rawG).toBe(200)
    expect(totals.kcal).toBeCloseTo(330, 6)
  })
})

describe('partly-recorded nutrients', () => {
  it('sums a nutrient over just the ingredients that declare it', () => {
    const { totals } = rollUpRecipe([
      { grams: 250, food: chicken },
      { grams: 200, food: rice },
      { grams: 50, food: oil },
    ])
    expect(totals.iron_mg).toBeCloseTo(2.5 + 0.4, 6)
  })

  it('still sums a nutrient when most of the weight is silent about it', () => {
    // Only 100 g of 500 g declare iron — the rest simply don't carry the
    // field. A vegetable-heavy recipe with a spoon of butter should show the
    // butter's fat rather than "not recorded" because the vegetables don't
    // carry a fat figure at all.
    const { totals } = rollUpRecipe([
      { grams: 100, food: chicken },
      { grams: 400, food: oil },
    ])
    expect(totals.iron_mg).toBeCloseTo(1, 6)
    expect(totals.kcal).not.toBeNull()
  })

  it('reports "not recorded" only when nothing in the mixture declares it', () => {
    const { totals } = rollUpRecipe([{ grams: 100, food: oil }])
    expect(totals.iron_mg).toBeNull()
  })

  it('sums declared nutrients the same with or without a stated yield', () => {
    // Note this differs from `totals.kcal`, which is unaffected by yield for
    // the same reason: weighing the pan can't create or destroy nutrition.
    const mixture = [
      { grams: 100, food: chicken },
      { grams: 400, food: oil },
    ]
    expect(rollUpRecipe(mixture, 250).totals.iron_mg).toBeCloseTo(1, 6)
    expect(rollUpRecipe(mixture, 250).totals.kcal).toBeCloseTo(165 + 3536, 6)
  })

  it('derives missing energy from the macros, like custom foods do', () => {
    const noEnergy = food({ kcal: null, protein_g: 10, carbs_g: 20, fat_g: 5 })
    const { totals } = rollUpRecipe([{ grams: 100, food: noEnergy }])
    expect(totals.kcal).toBeCloseTo(10 * 4 + 20 * 4 + 5 * 9, 6)
  })

  it('leaves energy unknown when the macros are unknown too', () => {
    const nothing = food({ kcal: null, protein_g: null, carbs_g: null, fat_g: null })
    expect(rollUpRecipe([{ grams: 100, food: nothing }]).totals.kcal).toBeNull()
  })
})

describe('servings', () => {
  it('divides the basis weight', () => {
    expect(recipeServingGrams(1000, 4)).toBe(250)
  })

  it('has no serving size until something is in the recipe', () => {
    expect(recipeServingGrams(0, 4)).toBeNull()
    expect(recipeServingGrams(1000, 0)).toBeNull()
  })

  it('calls a one-serving recipe what it is', () => {
    // Offering both "1 serving" and "whole recipe" for the same amount is two
    // names for one thing.
    expect(recipeServingLabel(1)).toBe(WHOLE_RECIPE_LABEL)
    expect(needsWholeRecipeOption(1)).toBe(false)

    expect(recipeServingLabel(4)).toBe('serving')
    expect(needsWholeRecipeOption(4)).toBe(true)
  })
})

describe('when gram portions may be shown', () => {
  it('always, for ordinary foods', () => {
    expect(showsGramPortions({ source: 'off' })).toBe(true)
    expect(showsGramPortions({ source: 'custom' })).toBe(true)
  })

  it('for a recipe that has been weighed', () => {
    expect(showsGramPortions({ source: RECIPE_SOURCE, recipe_final_weight_g: 900 })).toBe(true)
  })

  it('never for a recipe that has not', () => {
    expect(showsGramPortions({ source: RECIPE_SOURCE, recipe_final_weight_g: null })).toBe(false)
    expect(showsGramPortions({ source: RECIPE_SOURCE })).toBe(false)
    expect(showsGramPortions({ source: RECIPE_SOURCE, recipe_final_weight_g: 0 })).toBe(false)
  })

  it('knows a recipe when it sees one', () => {
    expect(isRecipe({ source: RECIPE_SOURCE })).toBe(true)
    expect(isRecipe({ source: 'custom' })).toBe(false)
  })

  /**
   * A meal logged from a recipe is frozen into its own food row, and every
   * display rule has to keep treating it as a recipe. Written as its own block
   * because the failure is invisible: an equality test against RECIPE_SOURCE
   * still passes every case above, and only the diary — the screen read most
   * often — starts quoting a weight for a stew nobody put on the scales.
   */
  it('treats a frozen meal as the recipe it came from', () => {
    expect(isRecipe({ source: RECIPE_LOG_SOURCE })).toBe(true)
    expect(isRecipeLog({ source: RECIPE_LOG_SOURCE })).toBe(true)
    expect(isRecipeLog({ source: RECIPE_SOURCE })).toBe(false)

    expect(showsGramPortions({ source: RECIPE_LOG_SOURCE })).toBe(false)
    expect(showsGramPortions({ source: RECIPE_LOG_SOURCE, recipe_final_weight_g: null }))
      .toBe(false)
    expect(showsGramPortions({ source: RECIPE_LOG_SOURCE, recipe_final_weight_g: 900 }))
      .toBe(true)
  })
})

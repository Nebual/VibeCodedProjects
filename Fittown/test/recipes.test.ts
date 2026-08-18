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
  applyAdjustments,
  describeAdjustments,
  ingredientIsIncluded,
  shortFoodName,
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

describe('optional ingredients', () => {
  /**
   * The invariant that would otherwise go quietly wrong: a switched-off
   * ingredient has to leave the coverage denominator as well as the weight sum.
   * If it only left the sum, 200 g of skipped bacon would still count as weight
   * that declares no vitamin K, and blank the whole recipe's vitamin K.
   */
  it('leave both the weight and the coverage denominator', () => {
    const kept = { grams: 100, food: chicken }
    const skipped = { grams: 300, food: oil, is_included: 0 }

    const rolled = rollUpRecipe([kept, skipped])

    expect(rolled.raw_g).toBe(100)
    expect(rolled.totals.kcal).toBeCloseTo(165, 6)
    // Chicken declares iron and is now 100% of the weight, so iron survives.
    // With the oil counted as weight it would be 25% covered, and null.
    expect(rolled.totals.iron_mg).toBeCloseTo(1, 6)
  })

  it('absent means included, so nothing that predates the column changes', () => {
    expect(ingredientIsIncluded({ grams: 1, food: chicken })).toBe(true)
    expect(ingredientIsIncluded({ grams: 1, food: chicken, is_included: 1 })).toBe(true)
    expect(ingredientIsIncluded({ grams: 1, food: chicken, is_included: 0 })).toBe(false)
    expect(ingredientIsIncluded({ grams: 1, food: chicken, is_included: null as never })).toBe(true)

    const withFlag = rollUpRecipe([{ grams: 100, food: chicken, is_included: 1 }])
    const without = rollUpRecipe([{ grams: 100, food: chicken }])
    expect(withFlag).toEqual(without)
  })
})

describe('adjusting a recipe for one meal', () => {
  const omelette = [
    { id: 1, grams: 200, food: chicken, serving_label: 'egg', serving_count: 4 },
    { id: 2, grams: 35, food: rice, serving_label: null, serving_count: null },
    { id: 3, grams: 50, food: oil, serving_label: null, serving_count: null, is_optional: 1, is_included: 0 },
  ]

  it('changes an amount without touching anything else', () => {
    const adjusted = applyAdjustments(omelette, [
      { op: 'set', ingredient_id: 1, grams: 150, serving_label: 'egg', serving_count: 3 },
    ])

    expect(adjusted[0]!.grams).toBe(150)
    expect(adjusted[0]!.serving_count).toBe(3)
    expect(adjusted[1]!.grams).toBe(35)
    expect(adjusted).toHaveLength(3)
  })

  it('keeps a skipped ingredient in the list, marked', () => {
    // It has to stay: the frozen copy is a record of the meal, and "no cheese"
    // is part of what happened. It just stops counting.
    const adjusted = applyAdjustments(omelette, [
      { op: 'set', ingredient_id: 2, included: false },
    ])

    expect(adjusted).toHaveLength(3)
    expect(adjusted[1]!.is_included).toBe(0)
    expect(rollUpRecipe(adjusted).raw_g).toBe(200)
  })

  it('swaps a food, and drops the row when the swap cannot be found', () => {
    const swapped = applyAdjustments(
      omelette,
      [{ op: 'set', ingredient_id: 2, food_id: 77 }],
      () => oil,
    )
    expect(swapped[1]!.food).toBe(oil)

    // No lookup: the food is gone, so the row has nothing to contribute and
    // must not silently keep the old one's nutrition.
    const missing = applyAdjustments(omelette, [{ op: 'set', ingredient_id: 2, food_id: 77 }])
    expect(missing[1]!.food).toBeNull()
  })

  it('adds something the recipe never had', () => {
    const adjusted = applyAdjustments(
      omelette,
      [{ op: 'add', food_id: 77, grams: 20 }],
      () => oil,
    )

    expect(adjusted).toHaveLength(4)
    expect(adjusted[3]!.grams).toBe(20)
    // No ingredient row of its own yet, so no id to address it by.
    expect(adjusted[3]!.id).toBe(0)
    expect(rollUpRecipe(adjusted).raw_g).toBe(255)
  })

  it('ignores an add whose food cannot be found', () => {
    expect(applyAdjustments(omelette, [{ op: 'add', food_id: 77, grams: 20 }])).toHaveLength(3)
  })

  it('takes the last edit when a row is adjusted twice', () => {
    const adjusted = applyAdjustments(omelette, [
      { op: 'set', ingredient_id: 1, grams: 150 },
      { op: 'set', ingredient_id: 1, grams: 100 },
    ])
    expect(adjusted[0]!.grams).toBe(100)
  })

  it('leaves the list alone when there is nothing to apply', () => {
    expect(applyAdjustments(omelette, [])).toEqual(omelette)
  })
})

describe('describing what was different about a meal', () => {
  it('reads as a sentence someone would say', () => {
    // The name is dropped when the amount already carries it, or this reads
    // "3 × egg Egg instead of 4 × egg".
    expect(describeAdjustments([
      { kind: 'amount', name: 'Egg', from: '4 × egg', to: '3 × egg' },
      { kind: 'skipped', name: 'Bacon' },
    ])).toBe('3 × egg instead of 4 × egg · no Bacon')

    // …and kept when it doesn't.
    expect(describeAdjustments([
      { kind: 'amount', name: 'Cheddar', from: '35 g', to: '20 g' },
    ])).toBe('20 g Cheddar instead of 35 g')

    expect(describeAdjustments([
      { kind: 'added', name: 'Cheddar', amount: '20 g' },
    ])).toBe('plus 20 g Cheddar')

    expect(describeAdjustments([
      { kind: 'swapped', name: 'Butter', to: 'Olive oil' },
    ])).toBe('Olive oil instead of Butter')
  })

  it('is null when nothing changed, so the diary line stays clean', () => {
    expect(describeAdjustments([])).toBeNull()
  })

  it('stops at three and counts the rest', () => {
    const notes = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ kind: 'skipped' as const, name }))
    expect(describeAdjustments(notes)).toBe('no A · no B · no C · +2 more')
  })
})

describe('shortening a food name for a diary line', () => {
  it('cuts a lab-analysed name at its first comma', () => {
    expect(shortFoodName('Chicken, broiler or fryers, breast, skinless, boneless'))
      .toBe('Chicken')
    expect(shortFoodName('Oil, olive, extra virgin')).toBe('Oil')
  })

  it('leaves a short name alone', () => {
    expect(shortFoodName('Cheddar')).toBe('Cheddar')
    expect(shortFoodName('Egg')).toBe('Egg')
  })

  it('clamps a long name with no comma to cut', () => {
    // 23 characters plus the ellipsis: the cap counts the ellipsis, because it
    // is what the line has room for, not what the name would like.
    const clamped = shortFoodName('Extraordinarily Long Product Name Here')
    expect(clamped).toBe('Extraordinarily Long Pr…')
    expect(clamped).toHaveLength(24)
  })

  it('ignores a leading fragment too short to identify anything', () => {
    // "A, long descriptive name" — the head is a letter, so keep the name and
    // clamp it instead of reporting "A".
    expect(shortFoodName('A, long descriptive name for a food')).toBe('A, long descriptive nam…')
  })
})

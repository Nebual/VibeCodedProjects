import { describe, expect, it } from 'vitest'
import {
  ingredientDetail,
  ingredientName,
  ingredientSearchTerm,
  isNestedRecipe,
  isResolved,
  portionText,
} from '../app/utils/ingredients'
import type { RecipeIngredient } from '../app/composables/useRecipes'

/**
 * How a recipe ingredient reads on screen.
 *
 * Shared by the editor and the read-only view, and the only place that knows
 * what an unmatched row — one with no food at all — should look like. Getting
 * this wrong is how a friend's imported recipe throws on render.
 */

const make = (over: Partial<RecipeIngredient> = {}): RecipeIngredient => ({
  id: 1,
  grams: 0,
  serving_label: null,
  serving_count: null,
  raw_text: null,
  note: null,
  sort_order: 0,
  food: null,
  nutrients: {},
  ...over,
} as RecipeIngredient)

const food = (over: Record<string, unknown> = {}) =>
  ({ id: 9, name: 'Balsamic vinegar', brand: null, is_liquid: 0, ...over }) as never

describe('naming an ingredient', () => {
  it('uses the food when there is one', () => {
    expect(ingredientName(make({ food: food() }))).toBe('Balsamic vinegar')
  })

  it('falls back to the pasted line when there is no food', () => {
    expect(ingredientName(make({ raw_text: 'a lot of oregano' }))).toBe('a lot of oregano')
  })

  it('never renders an empty name', () => {
    expect(ingredientName(make())).toBe('Unnamed ingredient')
  })

  it('knows which rows still need a food', () => {
    expect(isResolved(make({ food: food() }))).toBe(true)
    expect(isResolved(make({ raw_text: 'oregano' }))).toBe(false)
  })
})

describe('the amount line', () => {
  it('shows a plain weight', () => {
    expect(portionText(make({ grams: 45, food: food() }))).toBe('45 g')
  })

  it('shows millilitres for a liquid', () => {
    expect(portionText(make({ grams: 250, food: food({ is_liquid: 1 }) }))).toBe('250 ml')
  })

  it('shows the portion it was entered as, and the weight', () => {
    const line = make({ grams: 59.147, serving_label: 'cup', serving_count: 0.25, food: food() })
    expect(portionText(line)).toBe('0.25 × cup · 59 g')
  })

  /**
   * "No yield, no grams" reaches ingredient rows too, now that an ingredient
   * can be another recipe. One serving of a dressing is exact; the weight
   * behind it is what went into the batch, not what came out of it.
   */
  it('does not quote a weight for a nested recipe nobody weighed', () => {
    const nested = make({
      grams: 50,
      serving_label: 'serving',
      serving_count: 1,
      food: food({ name: 'Salad Dressing', source: 'recipe', recipe_final_weight_g: null }),
    })
    expect(portionText(nested)).toBe('1 × serving')

    // Weigh the finished batch and the weight becomes quotable again.
    const weighed = make({
      grams: 50,
      serving_label: 'serving',
      serving_count: 1,
      food: food({ name: 'Salad Dressing', source: 'recipe', recipe_final_weight_g: 300 }),
    })
    expect(portionText(weighed)).toBe('1 × serving · 50 g')
  })

  it('still shows the weight when that is all there is to show', () => {
    // Entered in grams against an unweighed recipe: the user typed 40 g, and
    // printing nothing would lose the only amount on the row.
    const grams = make({
      grams: 40,
      food: food({ name: 'Salad Dressing', source: 'recipe', recipe_final_weight_g: null }),
    })
    expect(portionText(grams)).toBe('40 g')
  })

  it('says nothing at all for an ingredient with no amount', () => {
    // Not "0 g". The amount is unknown, not zero, and printing a measurement
    // nobody took is the same lie as `?? 0` on a nutrient.
    expect(portionText(make({ grams: 0, food: food() }))).toBe('')
  })

  it('puts brand, amount and note together', () => {
    const line = make({ grams: 45, note: 'minced', food: food({ brand: 'Pompeian' }) })
    expect(ingredientDetail(line)).toBe('Pompeian · 45 g · minced')
  })

  it('drops the empty parts rather than leaving stray separators', () => {
    expect(ingredientDetail(make({ note: 'a lot of', raw_text: 'a lot of oregano' })))
      .toBe('a lot of')
  })
})

describe('the search term for changing an ingredient', () => {
  it('strips the amount out of the original line', () => {
    // The raw line can't be searched as-is: FTS prefix-matches every term with
    // AND, so "1/4c avocado oil" looks for something starting "1" and "4c" too.
    expect(ingredientSearchTerm(make({ raw_text: '1/4c avocado oil' }))).toBe('avocado oil')
    expect(ingredientSearchTerm(make({ raw_text: '2 tbsp fresh basil, chopped' })))
      .toBe('fresh basil')
  })

  it('prefers the original line over a wrong match', () => {
    // This is the case the Change button exists for: the food's own name
    // carries the very words that made the match wrong.
    const line = make({
      raw_text: '1/4c avocado oil',
      food: food({ name: 'Avocado Oil Cooking Spray' }),
    })
    expect(ingredientSearchTerm(line)).toBe('avocado oil')
  })

  it('uses the food name when the row was added by hand', () => {
    expect(ingredientSearchTerm(make({ food: food({ name: 'Olive oil' }) }))).toBe('Olive oil')
  })

  it('returns something searchable for a descriptor-only line', () => {
    expect(ingredientSearchTerm(make({ raw_text: 'a lot of oregano' }))).toBe('oregano')
  })
})

describe('spotting a recipe inside a recipe', () => {
  it('knows one when the ingredient is a recipe', () => {
    expect(isNestedRecipe(make({ food: food({ source: 'recipe' }) }))).toBe(true)
    expect(isNestedRecipe(make({ food: food({ source: 'off' }) }))).toBe(false)
    expect(isNestedRecipe(make({ food: food({ source: 'custom' }) }))).toBe(false)
  })

  it('is false for a line with no food at all', () => {
    expect(isNestedRecipe(make({ raw_text: 'a lot of oregano' }))).toBe(false)
  })
})

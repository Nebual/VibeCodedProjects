import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { portionAmount } from '../shared/portions'
import { usePortionOptions, type PortionPickerState } from '../app/composables/usePortionOptions'
import type { FoodRow } from '../app/composables/useDiary'

/**
 * Switching portion types re-expresses the weight already on screen in the
 * newly picked unit, instead of resetting the amount to a default. "2 × 90 g
 * serving" switching to grams should land on 180, not on 1 g.
 */

/** A plain food with one 90 g serving, so gram portions are offered. */
const plainFood = (): FoodRow =>
  ({
    id: 1,
    source: 'off',
    barcode: null,
    name: 'Test food',
    brand: null,
    quantity: null,
    image_url: null,
    serving_size_text: 'serving',
    serving_grams: 90,
    is_liquid: 0,
    owner_user_id: null,
    nutriscore: null,
    kcal: 100,
    recipe_servings: null,
    recipe_final_weight_g: null,
  }) as FoodRow

/**
 * What PortionPicker.vue's selectOption does: capture the weight before the
 * selection moves, then hand it back to re-express in the new unit.
 */
function select(picker: PortionPickerState, key: string) {
  const previousGrams = picker.grams
  picker.selectedKey = key
  picker.onPortionChange(previousGrams)
}

describe('portionAmount — honest rounding when re-expressing a weight', () => {
  it('rounds to the nearest gram when that stays within a gram (3 oz → g = 85, not 85.05)', () => {
    expect(portionAmount(3 * 28.349523125, 1)).toBe(85)
  })

  it('keeps a decimal when the whole unit would be off (90 g → oz = 3.2, not 3)', () => {
    // 90 g ÷ oz = 3.174…; 3 oz would be 85 g (5 g off), so 3.2 oz (90.7 g).
    expect(portionAmount(90, 28.349523125)).toBeCloseTo(3.2, 1)
  })

  it('keeps a gram-sized jump for a larger unit', () => {
    // 200 g as 100 g portions is exactly 2.
    expect(portionAmount(200, 100)).toBe(2)
    // 30 g as 100 g portions: 0.3 is exact, whole units would be 0 or 100 g.
    expect(portionAmount(30, 100)).toBeCloseTo(0.3, 7)
  })

  it('rounds a small total to the nearest 0.1 g, never to a whole gram', () => {
    // 5 g as 12 g servings: whole servings jump 12 g at a time.
    expect(portionAmount(5, 12)).toBeCloseTo(0.4, 7)
    // 4 g straight into grams is still 4 (it is already exact).
    expect(portionAmount(4, 1)).toBe(4)
  })

  it('never reports more than two decimals', () => {
    expect(portionAmount(1, 453.59237)).toBe(0.0) // 1 g in pounds
    expect(portionAmount(137, 28.349523125).toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2)
  })
})

describe('usePortionOptions — preserving amount across portion switches', () => {
  it('re-expresses servings as their gram weight when switching to grams', () => {
    const picker = usePortionOptions(ref(plainFood()), ref([]), ref('metric'))

    // 2 servings × 90 g serving.
    picker.selectedKey = 'serving'
    picker.amount = 2
    expect(picker.grams).toBe(180)

    select(picker, 'u:g')

    expect(picker.amount).toBe(180)
    expect(picker.grams).toBe(180)
  })

  it('re-expresses a gram weight as a serving count when switching to a serving', () => {
    const picker = usePortionOptions(ref(plainFood()), ref([]), ref('metric'))

    // 1 × 100 g.
    picker.selectedKey = 'u:100g'
    picker.amount = 1
    expect(picker.grams).toBe(100)

    select(picker, 'serving') // the 90 g serving

    // 100 g ÷ 90 g per serving = 1.11, rounded to 1.1 (99 g, within a gram).
    expect(picker.amount).toBeCloseTo(1.1, 1)
    expect(picker.grams).toBeCloseTo(99, 0)
  })

  it('keeps the weight across a same-size unit switch (g → 100 g)', () => {
    const picker = usePortionOptions(ref(plainFood()), ref([]), ref('metric'))

    picker.selectedKey = 'u:g'
    picker.amount = 200
    expect(picker.grams).toBe(200)

    select(picker, 'u:100g')

    // 200 g ÷ 100 g = 2 × 100 g.
    expect(picker.amount).toBe(2)
    expect(picker.grams).toBe(200)
  })

  it('rounds an oz amount to whole grams when switching to grams', () => {
    const picker = usePortionOptions(ref(plainFood()), ref([]), ref('imperial'))

    // 3 oz.
    picker.selectedKey = 'u:oz'
    picker.amount = 3
    expect(picker.grams).toBeCloseTo(85.05, 1)

    select(picker, 'u:g')

    // 85 g, not 85.05 g — it is within a gram.
    expect(picker.amount).toBe(85)
    expect(picker.grams).toBe(85)
  })

  it('rounds a gram weight to a sensible oz figure when switching to oz', () => {
    const picker = usePortionOptions(ref(plainFood()), ref([]), ref('imperial'))

    picker.selectedKey = 'u:g'
    picker.amount = 90

    select(picker, 'u:oz')

    // 90 g ÷ oz = 3.17; 3.2 oz (90.7 g) is preferred over 3.17.
    expect(picker.amount).toBeCloseTo(3.2, 1)
    expect(picker.grams).toBeCloseTo(90.7, 0)
  })

  it('keeps a fine grain for a small amount', () => {
    const picker = usePortionOptions(ref(plainFood()), ref([]), ref('metric'))

    picker.selectedKey = 'u:g'
    picker.amount = 5
    expect(picker.grams).toBe(5)

    select(picker, 'serving') // 90 g serving

    // 5 g ÷ 90 g = 0.0556 servings. A small total never collapses to whole
    // servings (that would be 0 or 9 g, both several grams off) — it keeps
    // the two-decimal figure 0.06 (5.4 g).
    expect(picker.amount).toBeCloseTo(0.06, 2)
    expect(picker.grams).toBeCloseTo(5.4, 1)
  })

  it('rounds a small total into a small serving at 0.1 g, not whole servings', () => {
    const smallServingFood: FoodRow = {
      ...plainFood(),
      serving_grams: 8,
    }
    const picker = usePortionOptions(ref(smallServingFood), ref([]), ref('metric'))

    picker.selectedKey = 'u:g'
    picker.amount = 10
    expect(picker.grams).toBe(10)

    select(picker, 'serving') // the 8 g serving

    // 10 g ÷ 8 g = 1.25 servings; a whole serving is 8 g, too coarse at this
    // size, so keep a tenth: 1.3 × 8 g = 10.4 g.
    expect(picker.amount).toBeCloseTo(1.3, 1)
  })
})

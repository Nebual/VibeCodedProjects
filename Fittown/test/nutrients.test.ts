import { describe, expect, it } from 'vitest'
import {
  NUTRIENTS,
  NUTRIENT_BY_KEY,
  NUTRIENT_KEYS,
  formatNutrient,
  scaleNutrients,
  sumNutrients,
} from '#shared/nutrients'

describe('nutrient catalogue', () => {
  it('has unique keys — they double as database columns', () => {
    expect(new Set(NUTRIENT_KEYS).size).toBe(NUTRIENT_KEYS.length)
  })

  it('is indexed consistently', () => {
    expect(NUTRIENT_BY_KEY.size).toBe(NUTRIENTS.length)
    for (const nutrient of NUTRIENTS) {
      expect(NUTRIENT_BY_KEY.get(nutrient.key)).toBe(nutrient)
    }
  })

  it('gives every nutrient a label, unit and precision', () => {
    for (const nutrient of NUTRIENTS) {
      expect(nutrient.label).toBeTruthy()
      expect(nutrient.unit).toBeTruthy()
      expect(Number.isInteger(nutrient.decimals)).toBe(true)
      expect(nutrient.decimals).toBeGreaterThanOrEqual(0)
    }
  })

  it('only marks a nutrient as a limit when it has a figure to stay under', () => {
    for (const nutrient of NUTRIENTS.filter((n) => n.limit)) {
      expect(nutrient.rda, `${nutrient.key} is a limit with no value`).toBeGreaterThan(0)
    }
  })
})

describe('scaleNutrients', () => {
  const food = { kcal: 200, protein_g: 10, iron_mg: null, vit_d_ug: undefined }

  it('scales a per-100g vector to the portion actually eaten', () => {
    const scaled = scaleNutrients(food, 250)
    expect(scaled.kcal).toBeCloseTo(500, 6)
    expect(scaled.protein_g).toBeCloseTo(25, 6)
  })

  it('omits unknown nutrients instead of calling them zero', () => {
    // The invariant the whole app rests on: "we don't know" must survive all
    // the way to the UI, which renders it as "not recorded".
    const scaled = scaleNutrients(food, 100)
    expect('iron_mg' in scaled).toBe(false)
    expect('vit_d_ug' in scaled).toBe(false)
  })

  it('keeps a recorded zero, which is a real measurement', () => {
    const scaled = scaleNutrients({ trans_fat_g: 0 }, 100)
    expect(scaled.trans_fat_g).toBe(0)
    expect('trans_fat_g' in scaled).toBe(true)
  })

  it('ignores non-numeric junk from the database', () => {
    const scaled = scaleNutrients({ kcal: 'abc', protein_g: Number.NaN }, 100)
    expect(scaled).toEqual({})
  })

  it('ignores columns that are not nutrients', () => {
    const scaled = scaleNutrients({ id: 42, name: 'Oats', kcal: 100 }, 100)
    expect(scaled).toEqual({ kcal: 100 })
  })

  it('returns zeroes for a zero-gram portion, not the per-100g values', () => {
    expect(scaleNutrients(food, 0).kcal).toBe(0)
  })
})

describe('sumNutrients', () => {
  it('adds vectors key by key', () => {
    const total = sumNutrients([{ kcal: 100, protein_g: 5 }, { kcal: 250, protein_g: 12 }])
    expect(total).toEqual({ kcal: 350, protein_g: 17 })
  })

  it('treats a key missing from one vector as absent, not zero', () => {
    // One food knowing its iron shouldn't be diluted by another that doesn't.
    const total = sumNutrients([{ kcal: 100, iron_mg: 2 }, { kcal: 100 }])
    expect(total).toEqual({ kcal: 200, iron_mg: 2 })
  })

  it('sums an empty day to nothing at all', () => {
    expect(sumNutrients([])).toEqual({})
  })
})

describe('formatNutrient', () => {
  it('uses each nutrient’s own precision', () => {
    expect(formatNutrient('kcal', 123.4)).toBe('123')
    expect(formatNutrient('protein_g', 12.34)).toBe('12.3')
    expect(formatNutrient('vit_b1_mg', 1.234)).toBe('1.23')
  })

  it('renders unknown values as a dash, never as 0', () => {
    expect(formatNutrient('iron_mg', null)).toBe('–')
    expect(formatNutrient('iron_mg', undefined)).toBe('–')
    expect(formatNutrient('iron_mg', Number.NaN)).toBe('–')
  })

  it('still renders a real zero', () => {
    expect(formatNutrient('trans_fat_g', 0)).toBe('0.00')
  })
})

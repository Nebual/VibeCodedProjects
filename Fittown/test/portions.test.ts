import { describe, expect, it } from 'vitest'
import {
  MASS_UNITS,
  VOLUME_UNITS,
  baseUnit,
  conversionText,
  defaultAmount,
  defaultUnitKey,
  portionUnits,
  roundGrams,
} from '#shared/portions'

describe('portion unit table', () => {
  it('uses the exact avoirdupois definitions', () => {
    const by = (key: string) => MASS_UNITS.find((u) => u.key === key)!
    expect(by('g').size).toBe(1)
    expect(by('100g').size).toBe(100)
    expect(by('oz').size).toBe(28.349523125)
    expect(by('lb').size).toBe(453.59237)
    expect(by('kg').size).toBe(1000)
    // Sixteen ounces to the pound, exactly.
    expect(by('oz').size * 16).toBeCloseTo(by('lb').size, 10)
  })

  it('uses US fluid measures, matching the US/Canada food import', () => {
    const by = (key: string) => VOLUME_UNITS.find((u) => u.key === key)!
    expect(by('floz').size).toBeCloseTo(29.5735295625, 10)
    // A US cup is eight fluid ounces. A metric cup (250 ml) would be a
    // silent 5% error on every recipe.
    expect(by('cup').size).toBeCloseTo(by('floz').size * 8, 8)
    expect(by('l').size).toBe(1000)
  })

  it('gives each list exactly one base unit', () => {
    for (const isLiquid of [false, true]) {
      const bases = portionUnits(isLiquid).filter((u) => u.size === 1)
      expect(bases).toHaveLength(1)
      expect(bases[0]!.key).toBe(baseUnit(isLiquid))
    }
  })

  it('keys are unique within each list', () => {
    for (const isLiquid of [false, true]) {
      const keys = portionUnits(isLiquid).map((u) => u.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('measures liquids in millilitres and solids in grams', () => {
    expect(baseUnit(false)).toBe('g')
    expect(baseUnit(true)).toBe('ml')
    expect(portionUnits(true)).toBe(VOLUME_UNITS)
    expect(portionUnits(false)).toBe(MASS_UNITS)
  })
})

describe('default unit selection', () => {
  it('opens on grams for metric and ounces for imperial', () => {
    expect(defaultUnitKey('metric', false)).toBe('g')
    expect(defaultUnitKey('metric', true)).toBe('ml')
    // Ounces, not pounds: nobody weighs a chicken breast in 0.3 lb.
    expect(defaultUnitKey('imperial', false)).toBe('oz')
    expect(defaultUnitKey('imperial', true)).toBe('floz')
  })

  it('always names a unit that exists', () => {
    for (const system of ['metric', 'imperial'] as const) {
      for (const isLiquid of [false, true]) {
        const key = defaultUnitKey(system, isLiquid)
        expect(portionUnits(isLiquid).some((u) => u.key === key)).toBe(true)
      }
    }
  })
})

describe('default amounts', () => {
  it('starts each unit at something like a real portion', () => {
    // Switching to grams and finding "1" in the box is useless; so is
    // switching to pounds and finding "100".
    expect(defaultAmount({ key: 'g', label: 'g', size: 1 })).toBe(100)
    expect(defaultAmount({ key: 'oz', label: 'oz', size: 28.349523125 })).toBe(4)
    expect(defaultAmount({ key: '100g', label: '100 g', size: 100 })).toBe(1)
    expect(defaultAmount({ key: 'lb', label: 'lb', size: 453.59237 })).toBe(0.5)
  })

  it('never resolves to an absurd portion for any unit', () => {
    for (const isLiquid of [false, true]) {
      for (const unit of portionUnits(isLiquid)) {
        const grams = defaultAmount(unit) * unit.size
        expect(grams).toBeGreaterThanOrEqual(50)
        expect(grams).toBeLessThanOrEqual(500)
      }
    }
  })
})

describe('rounding', () => {
  it('rounds like a kitchen scale', () => {
    expect(roundGrams(113.398)).toBe(113)
    expect(roundGrams(28.349)).toBe(28)
    expect(roundGrams(453.592)).toBe(454)
  })

  it('keeps a decimal for small amounts, where whole grams lose too much', () => {
    expect(roundGrams(2.35)).toBe(2.4)
    expect(roundGrams(0.42)).toBe(0.4)
  })
})

describe('conversion text', () => {
  it('spells out what a non-base unit works out to', () => {
    const oz = MASS_UNITS.find((u) => u.key === 'oz')!
    expect(conversionText(4, oz, false)).toBe('4 × oz = 113 g')
    expect(conversionText(1, oz, false)).toBe('1 × oz = 28 g')
  })

  it('reports liquids in millilitres', () => {
    const floz = VOLUME_UNITS.find((u) => u.key === 'floz')!
    expect(conversionText(2, floz, true)).toBe('2 × fl oz = 59 ml')
  })

  it('handles fractional amounts', () => {
    const lb = MASS_UNITS.find((u) => u.key === 'lb')!
    expect(conversionText(0.5, lb, false)).toBe('0.5 × lb = 227 g')
  })
})

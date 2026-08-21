import { describe, expect, it } from 'vitest'
import {
  isPureAddedSugar,
  PURE_SUGAR_MIN_SUGARS,
} from '../scripts/lib/pureSugar.mjs'

describe('pure-added-sugar classification', () => {
  it('flags refined sucrose products across all three name/category shapes', () => {
    // OFF: terminal category is the pure-sugars umbrella (catches non-English names)
    expect(isPureAddedSugar('Sweeteners,Sugars', 'sucanat')).toBe(true)
    expect(isPureAddedSugar('Sweeteners,Sugars', 'Raffinade Zucker')).toBe(true)
    expect(isPureAddedSugar('Sweeteners,Sugars,Granulated sugars,White sugars', 'Sucre')).toBe(true)
    // USDA-style leading-noun: "Sugars, granulated"
    expect(isPureAddedSugar('Sweets', 'Sugars, granulated')).toBe(true)
    // Product-name IS sugar (USDA Branded)
    expect(isPureAddedSugar(null, 'White Granulated Sugar')).toBe(true)
    expect(isPureAddedSugar(null, 'Pure Cane Dark Brown Sugar')).toBe(true)
    expect(isPureAddedSugar(null, 'Turbinado Cane Sugar')).toBe(true)
    expect(isPureAddedSugar(null, 'Demerara Cane Sugar')).toBe(true)
    expect(isPureAddedSugar(null, 'Confectioners Powdered Sugar')).toBe(true)
    expect(isPureAddedSugar(null, 'Organic Coconut Sugar')).toBe(true)
  })

  it('refuses zero- and no-calorie sweeteners that share the Sugars category', () => {
    expect(isPureAddedSugar('Sweeteners,Sugars', 'Organic Stevia')).toBe(false)
    expect(isPureAddedSugar('Sweeteners,Sugars', 'Monk Fruit Sweetener')).toBe(false)
    expect(isPureAddedSugar('Sweeteners,Sugars', 'Erythritol')).toBe(false)
    expect(isPureAddedSugar('Sweeteners,Sugars', 'Allulose')).toBe(false)
    expect(isPureAddedSugar('Sweeteners,Sugars', 'Splenda')).toBe(false)
    expect(isPureAddedSugar('Sweeteners,Sugars', 'Zero Calorie Sweetener')).toBe(false)
    expect(isPureAddedSugar('Sweeteners,Sugars', 'Sugar Free Gum')).toBe(false)
  })

  it('refuses single-ingredient syrups and honey (not "added sugar")', () => {
    expect(isPureAddedSugar('Bee products,Sweeteners,Raw-honey', 'Pure Honey')).toBe(false)
    expect(isPureAddedSugar('Sweeteners,Syrups,Maple syrups', 'Maple Syrup')).toBe(false)
    expect(isPureAddedSugar('Sweeteners,Syrups,Molasses', 'Blackstrap Molasses')).toBe(false)
    expect(isPureAddedSugar('Sweeteners,Syrups,Agave syrups', 'Blue Agave')).toBe(false)
  })

  it('refuses foods that merely contain sugar', () => {
    expect(isPureAddedSugar(null, 'Nestle Gobstopper Sugar Candy')).toBe(false)
    expect(isPureAddedSugar(null, 'Keebler Sugar Wafers Cookies')).toBe(false)
    expect(isPureAddedSugar(null, 'Swiss Miss Hot Cocoa Mix')).toBe(false)
    expect(isPureAddedSugar(null, "Ham Glaze, Maple Brown Sugar")).toBe(false)
    expect(isPureAddedSugar(null, 'Sugar Free Gum')).toBe(false)
    expect(isPureAddedSugar(null, 'Wild Lingonberries Stirred With Sugar')).toBe(false)
    expect(isPureAddedSugar(null, 'Rose petals with sugar')).toBe(false)
  })

  it('exposes a high total-sugars floor for callers to gate on', () => {
    expect(PURE_SUGAR_MIN_SUGARS).toBeGreaterThanOrEqual(70) // genuine sugars are ~100
    expect(PURE_SUGAR_MIN_SUGARS).toBeLessThanOrEqual(95)
  })
})

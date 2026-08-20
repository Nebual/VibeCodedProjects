import { describe, expect, it } from 'vitest'
import {
  LabelOcrError,
  labelNameToKey,
  parseLabelOcrResponse,
} from '../server/utils/labelOcr'

/**
 * The vision model's reply is untrusted text — these tests describe the shapes
 * it actually tends to produce (a clean object, one with nutrients as an
 * object instead of an array, bilingual French titles) rather than calling out
 * to a real model. The mapping from label names to canonical nutrient keys is
 * the part with edge cases worth pinning down.
 */

describe('labelNameToKey', () => {
  it('maps the core label nutrients to canonical keys', () => {
    expect(labelNameToKey('Calories')).toBe('kcal')
    expect(labelNameToKey('Fat')).toBe('fat_g')
    expect(labelNameToKey('Saturated')).toBe('sat_fat_g')
    expect(labelNameToKey('Trans')).toBe('trans_fat_g')
    expect(labelNameToKey('Cholesterol')).toBe('cholesterol_mg')
    expect(labelNameToKey('Sodium')).toBe('sodium_mg')
    expect(labelNameToKey('Carbohydrate')).toBe('carbs_g')
    expect(labelNameToKey('Fibre')).toBe('fiber_g')
    expect(labelNameToKey('Sugars')).toBe('sugars_g')
    expect(labelNameToKey('Protein')).toBe('protein_g')
    expect(labelNameToKey('Potassium')).toBe('potassium_mg')
    expect(labelNameToKey('Calcium')).toBe('calcium_mg')
    expect(labelNameToKey('Iron')).toBe('iron_mg')
  })

  it('ignores the French side of a bilingual label', () => {
    expect(labelNameToKey('Fat / Lipides')).toBe('fat_g')
    expect(labelNameToKey('Sugars / Sucres')).toBe('sugars_g')
    expect(labelNameToKey('Saturated / gras saturés')).toBe('sat_fat_g')
  })

  it('handles "of which" phrasing and variant spellings', () => {
    expect(labelNameToKey('of which Saturates')).toBe('sat_fat_g')
    expect(labelNameToKey('of which Sugars')).toBe('sugars_g')
    expect(labelNameToKey('Carbohydrates')).toBe('carbs_g')
    expect(labelNameToKey('Fiber')).toBe('fiber_g')
  })

  it('returns null for something that is not a stored nutrient', () => {
    expect(labelNameToKey('% Daily Value')).toBeNull()
    expect(labelNameToKey('Niacinamide')).toBeNull()
    expect(labelNameToKey('')).toBeNull()
  })
})

describe('parseLabelOcrResponse', () => {
  it('reads a clean reply with nutrients as an array', () => {
    const result = parseLabelOcrResponse(JSON.stringify({
      serving_label: '3 bars (45 g)',
      serving_grams: 45,
      nutrients: [
        { name: 'Calories', value: 210 },
        { name: 'Fat', value: 15 },
        { name: 'Saturated', value: 14 },
        { name: 'Trans', value: 0 },
        { name: 'Carbohydrate', value: 24 },
        { name: 'Fibre', value: 3 },
        { name: 'Sugars', value: 9 },
        { name: 'Protein', value: 2 },
        { name: 'Cholesterol', value: 0 },
        { name: 'Sodium', value: 0 },
        { name: 'Potassium', value: 150 },
        { name: 'Calcium', value: 0 },
        { name: 'Iron', value: 1.75 },
      ],
    }))

    expect(result.serving).toEqual({ label: '3 bars (45 g)', grams: 45 })
    expect(result.nutrients).toEqual({
      kcal: 210,
      fat_g: 15,
      sat_fat_g: 14,
      trans_fat_g: 0,
      carbs_g: 24,
      fiber_g: 3,
      sugars_g: 9,
      protein_g: 2,
      cholesterol_mg: 0,
      sodium_mg: 0,
      potassium_mg: 150,
      calcium_mg: 0,
      iron_mg: 1.75,
    })
  })

  it('pulls JSON out of a code fence with a preamble sentence', () => {
    const result = parseLabelOcrResponse(
      'Here is the label:\\n```json\\n' + JSON.stringify({
        serving_label: 'Per 1 bar (15 g)',
        serving_grams: 15,
        nutrients: [{ name: 'Calories', value: 90 }],
      }) + '\\n```',
    )
    expect(result.serving.grams).toBe(15)
    expect(result.nutrients).toEqual({ kcal: 90 })
  })

  it('accepts nutrients as a name→value object', () => {
    const result = parseLabelOcrResponse(JSON.stringify({
      serving_label: '1 cup (250 mL)',
      nutrients: { Calories: 110, Sodium: 180 },
    }))
    expect(result.nutrients).toEqual({ kcal: 110, sodium_mg: 180 })
  })

  it('reads bilingual names and skips % Daily Value', () => {
    const result = parseLabelOcrResponse(JSON.stringify({
      serving_label: '3 bars (45 g)',
      serving_grams: 45,
      nutrients: [
        { name: 'Fat / Lipides', value: 15 },
        { name: '% Daily Value', value: 23 },
        { name: 'Protein / Protéines', value: 2 },
      ],
    }))
    expect(result.nutrients).toEqual({ fat_g: 15, protein_g: 2 })
  })

  it('falls back to parsing grams out of the serving label', () => {
    const result = parseLabelOcrResponse(JSON.stringify({
      serving_label: 'Per 3 bars (45 g)',
      nutrients: [{ name: 'Calories', value: 210 }],
    }))
    expect(result.serving.grams).toBe(45)
    expect(result.nutrients).toEqual({ kcal: 210 })
  })

  it('keeps a per-100g label with no serving weight', () => {
    const result = parseLabelOcrResponse(JSON.stringify({
      serving_label: null,
      serving_grams: null,
      nutrients: [{ name: 'Calories', value: 210 }],
    }))
    expect(result.serving).toEqual({ label: null, grams: null })
    expect(result.nutrients).toEqual({ kcal: 210 })
  })

  it('drops values that are not sane numbers', () => {
    const result = parseLabelOcrResponse(JSON.stringify({
      serving_label: '3 bars (45 g)',
      nutrients: [
        { name: 'Calories', value: -5 },
        { name: 'Sodium', value: 'lots' },
        { name: 'Fat', value: 1000000000000 },
        { name: 'Protein', value: 7 },
      ],
    }))
    expect(result.nutrients).toEqual({ protein_g: 7 })
  })

  it('throws on a reply with no JSON object in it', () => {
    expect(() => parseLabelOcrResponse('Sorry, I can’t read that image.')).toThrow(LabelOcrError)
  })

  it('throws on malformed JSON', () => {
    expect(() => parseLabelOcrResponse('{"serving_label": "x", "nutrients": [')).toThrow(LabelOcrError)
  })

  it('throws when the reply is not object-shaped', () => {
    expect(() => parseLabelOcrResponse('["just", "a", "list"]')).toThrow(LabelOcrError)
  })
})

import { describe, expect, it } from 'vitest'
import { parseOcrResponse, RecipeOcrError } from '../server/utils/recipeOcr'

/**
 * The vision model's reply is untrusted text, not a schema — these tests
 * describe the shapes it actually tends to produce (a clean object, one
 * wrapped in a code fence, one with a stray sentence) rather than calling out
 * to a real model.
 */

describe('parseOcrResponse', () => {
  it('reads a clean JSON reply', () => {
    const result = parseOcrResponse(
      '{"name": "Balsamic Vinaigrette", "ingredients": ["1/4 cup olive oil", "2 tbsp balsamic vinegar"], "instructions": "Whisk together.", "servings": 4}',
    )
    expect(result).toEqual({
      name: 'Balsamic Vinaigrette',
      ingredients: '1/4 cup olive oil\n2 tbsp balsamic vinegar',
      instructions: 'Whisk together.',
      servings: 4,
    })
  })

  it('pulls JSON out of a markdown code fence with a preamble sentence', () => {
    const result = parseOcrResponse(
      'Sure, here is the recipe:\n```json\n{"name": "Toast", "ingredients": ["1 slice bread"], "instructions": null, "servings": null}\n```',
    )
    expect(result.name).toBe('Toast')
    expect(result.ingredients).toBe('1 slice bread')
  })

  it('drops non-string and blank ingredient entries', () => {
    const result = parseOcrResponse(
      '{"name": null, "ingredients": ["1 egg", "", "  ", 2, "1 cup flour"], "instructions": null, "servings": null}',
    )
    expect(result.ingredients).toBe('1 egg\n1 cup flour')
  })

  it('throws when there are no ingredients at all', () => {
    expect(() =>
      parseOcrResponse('{"name": null, "ingredients": [], "instructions": null, "servings": null}'),
    ).toThrow(RecipeOcrError)
  })

  it('throws on a reply with no JSON object in it', () => {
    expect(() => parseOcrResponse('Sorry, I can’t read that image.')).toThrow(RecipeOcrError)
  })

  it('throws on malformed JSON', () => {
    expect(() => parseOcrResponse('{"name": "Toast", "ingredients": [')).toThrow(RecipeOcrError)
  })

  it('ignores an out-of-range or non-numeric servings value', () => {
    const negative = parseOcrResponse(
      '{"name": null, "ingredients": ["1 egg"], "instructions": null, "servings": -2}',
    )
    expect(negative.servings).toBeNull()

    const stringy = parseOcrResponse(
      '{"name": null, "ingredients": ["1 egg"], "instructions": null, "servings": "4 to 6"}',
    )
    expect(stringy.servings).toBeNull()
  })
})

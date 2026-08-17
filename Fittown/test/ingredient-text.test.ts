import { describe, expect, it } from 'vitest'
import { parseIngredientLine, parseIngredientList } from '#shared/ingredientText'

/**
 * The ingredient parser.
 *
 * Every import path runs through this, and a wrong answer here is a wrong
 * calorie count that looks entirely reasonable — so the cases are written as
 * data and the numbers are stated rather than derived.
 */

const parse = (line: string) => {
  const result = parseIngredientLine(line)
  if (!result) throw new Error(`expected "${line}" to parse`)
  return result
}

describe('the lines from the original request', () => {
  it('reads a volume with no space before the unit', () => {
    const line = parse('1/4c avocado oil')
    expect(line.name).toBe('avocado oil')
    // A quarter of a US cup, 59.147 ml, stored 1:1 as base units.
    expect(line.grams).toBeCloseTo(59.147, 2)
    expect(line.serving_label).toBe('cup')
    expect(line.serving_count).toBe(0.25)
    expect(line.note).toBeNull()
  })

  it('reads a plain weight and gives it no portion label', () => {
    const line = parse('45g balsamic vinegar')
    expect(line.name).toBe('balsamic vinegar')
    expect(line.grams).toBe(45)
    // Grams are the base unit; "1 × g" is not a portion anyone picked.
    expect(line.serving_label).toBeNull()
    expect(line.serving_count).toBeNull()
  })

  it('turns "pinch of" into a note and no amount', () => {
    const line = parse('pinch of salt')
    expect(line.name).toBe('salt')
    expect(line.grams).toBe(0)
    expect(line.note).toBe('pinch of')
  })

  it('turns "a lot of" into a note and no amount', () => {
    const line = parse('a lot of oregano')
    expect(line.name).toBe('oregano')
    expect(line.grams).toBe(0)
    expect(line.note).toBe('a lot of')
  })

  it('takes a bare name as 0 g with nothing to say about it', () => {
    const line = parse('garlic powder')
    expect(line.name).toBe('garlic powder')
    expect(line.grams).toBe(0)
    expect(line.note).toBeNull()
  })

  it('parses the whole block, in order', () => {
    const lines = parseIngredientList(
      ['1/4c avocado oil', '45g balsamic vinegar', 'pinch of salt', 'a lot of oregano', 'garlic powder'].join('\n'),
    )
    expect(lines.map((l) => l.name)).toEqual([
      'avocado oil', 'balsamic vinegar', 'salt', 'oregano', 'garlic powder',
    ])
    // Two of the five carry a weight; the rest are for the user to decide.
    expect(lines.filter((l) => l.grams > 0)).toHaveLength(2)
  })
})

describe('quantities', () => {
  const cases: [string, number][] = [
    ['2 tbsp olive oil', 29.5735],
    ['1 tbsp olive oil', 14.7868],
    ['1 tsp salt', 4.9289],
    ['2 cups flour', 473.1765],
    ['1 1/2 cups flour', 354.8824],
    ['1½ cups flour', 354.8824],
    ['1 ½ cups flour', 354.8824],
    ['½ cup flour', 118.2941],
    ['⅓ cup sugar', 78.8627],
    ['.5 cup milk', 118.2941],
    ['8 oz chicken breast', 226.7962],
    ['1 lb ground beef', 453.5924],
    ['1.5 kg potatoes', 1500],
    ['250 ml stock', 250],
    ['1 L water', 1000],
    ['2 fl oz cream', 59.1471],
    ['1,5 dl cream', 150],
  ]

  it.each(cases)('reads %s', (line, grams) => {
    expect(parse(line).grams).toBeCloseTo(grams, 3)
  })

  it('honours the recipe convention that T is a tablespoon and t a teaspoon', () => {
    expect(parse('1 T butter').grams).toBeCloseTo(14.7868, 3)
    expect(parse('1 t vanilla').grams).toBeCloseTo(4.9289, 3)
  })

  it('accepts a trailing period on the unit', () => {
    expect(parse('2 Tbsp. honey').grams).toBeCloseTo(29.5735, 3)
    expect(parse('2 Tbsp. honey').name).toBe('honey')
  })

  it('takes the lower end of a range and says so', () => {
    const line = parse('1 to 2 tbsp honey')
    expect(line.grams).toBeCloseTo(14.7868, 3)
    expect(line.serving_count).toBe(1)
    expect(line.note).toContain('1 to 2')
    expect(line.name).toBe('honey')
  })

  it('handles an en-dash range', () => {
    expect(parse('2–3 cups broth').grams).toBeCloseTo(473.1765, 3)
  })
})

describe('what is not a unit', () => {
  it('does not read "clove" as a cup', () => {
    // `c` is a cup and `clove` starts with it. Getting this wrong turns one
    // garlic clove into 237 ml of garlic.
    const line = parse('1 garlic clove, minced')
    expect(line.grams).toBe(0)
    expect(line.serving_label).toBeNull()
    expect(line.name).toBe('garlic clove')
    expect(line.note).toContain('minced')
  })

  it('does not read "large" as a litre', () => {
    const line = parse('2 large eggs')
    expect(line.grams).toBe(0)
    expect(line.name).toBe('large eggs')
    expect(line.note).toBe('2')
  })

  it('keeps a bare count as a note for the user to resolve', () => {
    expect(parse('3 carrots').note).toBe('3')
    expect(parse('3 carrots').grams).toBe(0)
  })
})

describe('tidying', () => {
  it('strips bullets, checkboxes and numbering', () => {
    expect(parse('- 45g sugar').name).toBe('sugar')
    expect(parse('• 45g sugar').name).toBe('sugar')
    expect(parse('▢ 45g sugar').name).toBe('sugar')
    expect(parse('1. 45g sugar').name).toBe('sugar')
    expect(parse('2) 45g sugar').name).toBe('sugar')
  })

  it('does not mistake a decimal or a fraction for numbering', () => {
    expect(parse('1.5 kg potatoes').grams).toBe(1500)
    expect(parse('1/4c avocado oil').serving_count).toBe(0.25)
  })

  it('moves parentheticals into the note', () => {
    const line = parse('2 large eggs (room temperature)')
    expect(line.name).toBe('large eggs')
    expect(line.note).toContain('room temperature')
  })

  it('moves prep words into the note', () => {
    const line = parse('1 cup walnuts, finely chopped')
    expect(line.name).toBe('walnuts')
    expect(line.note).toContain('finely chopped')
    expect(line.grams).toBeCloseTo(236.5882, 3)
  })

  it('handles "to taste" with no amount at all', () => {
    const line = parse('Salt and pepper to taste')
    expect(line.grams).toBe(0)
    expect(line.note).toContain('to taste')
    expect(line.name).toBe('Salt and pepper')
  })

  it('keeps "optional" rather than dropping it', () => {
    expect(parse('1 tsp chili flakes (optional)').note).toContain('optional')
  })

  it('never returns an empty name', () => {
    // Nothing but an amount. The row still has to show the user something.
    expect(parse('2 tbsp').name).not.toBe('')
  })

  it('keeps the raw line verbatim', () => {
    expect(parse('  ▢ 1/4c avocado oil  ').raw).toBe('▢ 1/4c avocado oil')
  })
})

describe('what is not an ingredient', () => {
  it('drops blank lines', () => {
    expect(parseIngredientLine('   ')).toBeNull()
    expect(parseIngredientList('a\n\n\nb')).toHaveLength(2)
  })

  it('drops section headings', () => {
    expect(parseIngredientLine('For the dressing:')).toBeNull()
    expect(parseIngredientLine('Dressing:')).toBeNull()
  })

  it('keeps a line that ends in a colon but states an amount', () => {
    expect(parseIngredientLine('2 cups flour:')).not.toBeNull()
  })
})

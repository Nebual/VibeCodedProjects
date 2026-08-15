import { describe, expect, it } from 'vitest'
import { bestMatch, meaningfulTokens, scoreMatch, splitBulkInput, stem } from '#shared/matching'

/** A list mid-restock: the sort of thing a bulk paste actually gets matched against. */
const LIST = [
  'Breton crackers', 'Canned salmon', 'Pecan', 'Eggs', 'Tomato sauce',
  'Canned corn', 'Black beans', 'Milk', 'Sourdough', 'Olive oil', 'Rice',
].map((name, index) => ({ id: `i${index}`, name }))

const match = (note: string, list = LIST) => bestMatch(note, list)?.name ?? null

describe('splitBulkInput', () => {
  it('splits on newlines, commas and semicolons', () => {
    expect(splitBulkInput('milk\neggs, bread; jam')).toEqual(['milk', 'eggs', 'bread', 'jam'])
  })

  it('strips list markers left behind by a paste', () => {
    expect(splitBulkInput('- milk\n* eggs\n• bread\n1. jam\n2) tea')).toEqual(['milk', 'eggs', 'bread', 'jam', 'tea'])
  })

  it('drops blank and punctuation-only lines', () => {
    expect(splitBulkInput('milk\n\n  \n,,\neggs')).toEqual(['milk', 'eggs'])
  })

  it('returns nothing for empty input', () => {
    expect(splitBulkInput('   \n\n')).toEqual([])
  })
})

describe('splitBulkInput — "+" and "-" running items onto one line', () => {
  // The worked example from the feature request.
  it('reads a detached + or - as the start of another item', () => {
    expect(splitBulkInput('tuna - nutritional yeast + garlic')).toEqual(['tuna', 'nutritional yeast', 'garlic'])
  })

  it('still reads a leading marker as a bullet rather than a separator', () => {
    expect(splitBulkInput('- crackers')).toEqual(['crackers'])
    expect(splitBulkInput('- tuna - nutritional yeast + garlic')).toEqual(['tuna', 'nutritional yeast', 'garlic'])
  })

  // The whole point of requiring whitespace on both sides.
  it('leaves compound names intact', () => {
    expect(splitBulkInput('half-and-half')).toEqual(['half-and-half'])
    expect(splitBulkInput('gluten-free bread')).toEqual(['gluten-free bread'])
    expect(splitBulkInput('7-up')).toEqual(['7-up'])
    expect(splitBulkInput('vitamin B+')).toEqual(['vitamin B+'])
  })

  it('drops a separator left dangling at the end of a line', () => {
    expect(splitBulkInput('tuna -\ngarlic')).toEqual(['tuna', 'garlic'])
    expect(splitBulkInput('- milk +')).toEqual(['milk'])
  })

  it('treats en and em dashes the same way', () => {
    expect(splitBulkInput('tuna – garlic')).toEqual(['tuna', 'garlic'])
    expect(splitBulkInput('tuna — garlic')).toEqual(['tuna', 'garlic'])
  })

  it('drops segments left holding nothing but punctuation', () => {
    expect(splitBulkInput('milk\n-\n+\neggs')).toEqual(['milk', 'eggs'])
  })

  // "+" is a bullet as well as a separator; without that it becomes part of the name.
  it('reads a leading + as a bullet, like every other marker', () => {
    expect(splitBulkInput('+ milk\n+ eggs\n+ bread')).toEqual(['milk', 'eggs', 'bread'])
    expect(splitBulkInput('+ tuna + garlic')).toEqual(['tuna', 'garlic'])
  })

  // A double-struck dash, or an em-dash that OCR read as two characters.
  it('splits on a doubled separator rather than swallowing the second item', () => {
    expect(splitBulkInput('tuna -- garlic')).toEqual(['tuna', 'garlic'])
    expect(splitBulkInput('tuna --- garlic')).toEqual(['tuna', 'garlic'])
  })

  // Splitting turns a trailing quantity into its own segment, and a bare number is a row
  // that can never match anything — it could only ever be deleted.
  it('drops a trailing quantity left stranded by the split', () => {
    expect(splitBulkInput('apples - 2')).toEqual(['apples'])
    expect(splitBulkInput('milk - 2%')).toEqual(['milk'])
    expect(splitBulkInput('eggs x2')).toEqual(['eggs x2'])
  })

  it('splits an indented bullet without leaving an empty first item', () => {
    expect(splitBulkInput('   - tuna - garlic')).toEqual(['tuna', 'garlic'])
  })

  it('composes with the other separators', () => {
    expect(splitBulkInput('milk, tuna - garlic\nbread + jam')).toEqual(['milk', 'tuna', 'garlic', 'bread', 'jam'])
  })
})

describe('meaningfulTokens', () => {
  it('drops quantities', () => {
    expect(meaningfulTokens('eggs x2')).toEqual(['eggs'])
    expect(meaningfulTokens('2x milk')).toEqual(['milk'])
    expect(meaningfulTokens('3 lemons')).toEqual(['lemons'])
  })

  it('drops leading filler words', () => {
    expect(meaningfulTokens('the Breton crackers')).toEqual(['breton', 'crackers'])
    expect(meaningfulTokens('need to grab some milk')).toEqual(['to', 'milk'])
  })

  it('strips punctuation and folds case', () => {
    expect(meaningfulTokens("Trader Joe's, MILK!")).toEqual(['trader', 'joe', 's', 'milk'])
  })

  it('keeps the raw tokens rather than returning nothing', () => {
    expect(meaningfulTokens('the')).toEqual(['the'])
    expect(meaningfulTokens('x2')).toEqual([])
  })
})

describe('stem', () => {
  it('folds common plurals', () => {
    expect(stem('pecans')).toBe('pecan')
    expect(stem('tomatoes')).toBe('tomato')
    expect(stem('boxes')).toBe('box')
    expect(stem('berries')).toBe('berry')
    expect(stem('crackers')).toBe('cracker')
  })

  it('leaves short words and non-plurals alone', () => {
    expect(stem('gas')).toBe('gas')
    expect(stem('grass')).toBe('grass')
    expect(stem('rice')).toBe('rice')
    expect(stem('oil')).toBe('oil')
  })
})

describe('bestMatch — the worked example', () => {
  // Exactly the paste from the feature request, and exactly what each line should hit.
  const cases: [string, string | null][] = [
    ['the Breton crackers', 'Breton crackers'],
    ['canned salmon', 'Canned salmon'],
    ['pecans', 'Pecan'],
    ['eggs x2', 'Eggs'],
    ['tomato sauce can', 'Tomato sauce'],
    ['canned corn reserves are low', 'Canned corn'],
    ['any fun fruit', null],
    ['black beans totally empty I think', 'Black beans'],
  ]

  it.each(cases)('%j matches %j', (note, expected) => {
    expect(match(note)).toBe(expected)
  })
})

describe('bestMatch — shapes that should match', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(match('  MILK  ')).toBe('Milk')
  })

  it('matches a shorthand against a longer item name', () => {
    expect(match('salmon')).toBe('Canned salmon')
    expect(match('corn')).toBe('Canned corn')
  })

  it('matches through trailing commentary', () => {
    expect(match('olive oil the big bottle')).toBe('Olive oil')
    expect(match('sourdough bread please')).toBe('Sourdough')
  })

  it('tolerates a typo in a long word', () => {
    expect(match('sourdogh')).toBe('Sourdough')
    expect(match('crakers')).toBe('Breton crackers')
  })

  it('matches either direction across a plural', () => {
    expect(match('pecans', [{ id: 'a', name: 'Pecan' }])).toBe('Pecan')
    expect(match('pecan', [{ id: 'a', name: 'Pecans' }])).toBe('Pecans')
  })
})

describe('bestMatch — shapes that should NOT match', () => {
  // Regression: "pecans" was matching "pears" on a 2-edit distance across 6 letters.
  it('does not match different foods that look similar', () => {
    expect(match('pecans', [{ id: 'a', name: 'Pears' }])).toBeNull()
    expect(match('pears', [{ id: 'a', name: 'Pecans' }])).toBeNull()
  })

  it('keeps short lookalike words apart', () => {
    expect(match('milk', [{ id: 'a', name: 'Silk' }])).toBeNull()
    expect(match('corn', [{ id: 'a', name: 'Cord' }])).toBeNull()
    expect(match('beans', [{ id: 'a', name: 'Bears' }])).toBeNull()
    expect(match('can', [{ id: 'a', name: 'Con' }])).toBeNull()
  })

  it('returns null for something genuinely absent', () => {
    expect(match('bananas')).toBeNull()
    expect(match('any fun fruit')).toBeNull()
  })

  it('returns null for input with no meaningful tokens', () => {
    expect(match('')).toBeNull()
    expect(match('x2')).toBeNull()
    expect(match('   ')).toBeNull()
  })

  it('does not match a bare unit word to a canned item', () => {
    expect(match('can')).toBeNull()
  })
})

describe('bestMatch — choosing between candidates', () => {
  it('prefers the more specific item when both are contained', () => {
    // Both "Corn" and "Canned corn" are present in the note; the longer one uses more of it.
    expect(match('canned corn reserves are low', [
      { id: 'a', name: 'Corn' },
      { id: 'b', name: 'Canned corn' },
    ])).toBe('Canned corn')
  })

  it('prefers an exact hit over a plural or typo', () => {
    expect(match('pecans', [
      { id: 'a', name: 'Pecan' },
      { id: 'b', name: 'Pecans' },
    ])).toBe('Pecans')
  })

  it('breaks ties towards the shorter name', () => {
    expect(match('milk', [
      { id: 'a', name: 'Milk drink' },
      { id: 'b', name: 'Milk' },
    ])).toBe('Milk')
  })

  it('copes with an empty list', () => {
    expect(match('milk', [])).toBeNull()
  })
})

describe('scoreMatch', () => {
  it('scores an exact token run at the top', () => {
    expect(scoreMatch(['canned', 'salmon'], ['canned', 'salmon'])).toBe(1)
  })

  it('scores nothing when a token is missing', () => {
    expect(scoreMatch(['bananas'], ['milk'])).toBe(0)
  })

  it('requires the item tokens to appear in order', () => {
    const inOrder = scoreMatch(['black', 'beans'], ['black', 'beans'])
    const reversed = scoreMatch(['beans', 'black'], ['black', 'beans'])
    expect(reversed).toBeLessThan(inOrder)
  })

  it('rewards a note that is mostly the item name', () => {
    const tight = scoreMatch(['black', 'beans'], ['black', 'beans'])
    const chatty = scoreMatch(['black', 'beans', 'totally', 'empty', 'i', 'think'], ['black', 'beans'])
    expect(chatty).toBeLessThan(tight)
    expect(chatty).toBeGreaterThan(0.62)
  })

  it('handles empty token lists', () => {
    expect(scoreMatch([], ['milk'])).toBe(0)
    expect(scoreMatch(['milk'], [])).toBe(0)
  })
})

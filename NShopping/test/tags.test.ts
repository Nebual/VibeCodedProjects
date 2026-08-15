import { describe, expect, it } from 'vitest'
import type { TagColor, TagSymbol } from '#shared/tags'
import { TAG_COLORS, TAG_COLOR_LABELS, TAG_SYMBOLS, TAG_SYMBOL_LABELS, isTagColor, isTagSymbol, tagRank } from '#shared/tags'

describe('tag vocabulary', () => {
  it('names every colour and symbol it defines', () => {
    for (const color of TAG_COLORS) expect(TAG_COLOR_LABELS[color]).toBeTruthy()
    for (const symbol of TAG_SYMBOLS) expect(TAG_SYMBOL_LABELS[symbol]).toBeTruthy()
  })

  it('has no duplicate colours, which would collapse two aisles into one rank', () => {
    expect(new Set(TAG_COLORS).size).toBe(TAG_COLORS.length)
  })
})

describe('isTagColor / isTagSymbol', () => {
  it('accepts what it defines', () => {
    for (const color of TAG_COLORS) expect(isTagColor(color)).toBe(true)
    for (const symbol of TAG_SYMBOLS) expect(isTagSymbol(symbol)).toBe(true)
  })

  it('rejects anything else, including the shapes a bad client sends', () => {
    for (const junk of ['chartreuse', '', null, undefined, 7, {}, ['green']]) {
      expect(isTagColor(junk)).toBe(false)
      expect(isTagSymbol(junk)).toBe(false)
    }
  })

  it('does not confuse a colour for a symbol', () => {
    expect(isTagSymbol('green')).toBe(false)
    expect(isTagColor('star')).toBe(false)
  })
})

describe('tagRank', () => {
  it('sorts untagged ahead of every colour, so new items stay at the top', () => {
    for (const color of TAG_COLORS) expect(tagRank(undefined)).toBeLessThan(tagRank(color))
  })

  it('follows the declared order, which is the order of the aisles', () => {
    const ranks = TAG_COLORS.map(tagRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(new Set(ranks).size).toBe(ranks.length)
  })

  // An older client's colour, or one dropped from the palette: it must land somewhere
  // predictable rather than at an arbitrary position.
  it('treats an unrecognised colour as untagged', () => {
    expect(tagRank('chartreuse' as TagColor)).toBe(tagRank(undefined))
  })

  it('is stable enough to sort with', () => {
    const items: { color?: TagColor }[] = [{ color: 'blue' }, {}, { color: 'green' }, { color: 'grey' }]
    expect([...items].sort((a, b) => tagRank(a.color) - tagRank(b.color)).map(i => i.color))
      .toEqual([undefined, 'green', 'blue', 'grey'])
  })
})

describe('symbol ids', () => {
  // The id is what lands in every stored list; the label is what the user reads. Keeping
  // them apart is what lets "Not at Costco" be renamed without rewriting the data.
  it('keeps ids free of the shop they happen to mean today', () => {
    for (const symbol of TAG_SYMBOLS) expect(symbol).not.toMatch(/costco/i)
    expect(TAG_SYMBOL_LABELS['other-store' as TagSymbol]).toBe('Not at Costco')
  })
})

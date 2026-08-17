import { describe, expect, it } from 'vitest'
import { prioritizeServingSize } from '#shared/foods'

/**
 * The search-result reorder, with no database in sight.
 *
 * A food with no `serving_grams` can only be logged in grams or a 100 g
 * pseudo-unit, never "1 serving" — so it's a worse hit than an equally-ranked
 * one that has a size. This guarantees the fold without touching relevance
 * order past it.
 */
describe('prioritizeServingSize', () => {
  function row(id: number, servingGrams: number | null) {
    return { id, serving_grams: servingGrams }
  }

  it('leaves an already-good list untouched', () => {
    const rows = [row(1, 100), row(2, 150), row(3, 200)]
    expect(prioritizeServingSize(rows, 2)).toEqual(rows)
  })

  it('pulls the first `window` serving-having rows to the front, preserving relative order otherwise', () => {
    const rows = [
      row(1, 100), // has serving — window slot 1
      row(2, null), // generic — held back
      row(3, 150), // has serving — window slot 2
      row(4, null), // generic — held back
      row(5, 200), // has serving — window slot 3, but window is 2 so this stays behind
    ]
    const result = prioritizeServingSize(rows, 2)
    expect(result.map((r) => r.id)).toEqual([1, 3, 2, 4, 5])
  })

  it('does nothing when fewer than `window` rows have a serving size at all', () => {
    // Only one row has a serving size; a window of 5 can never be filled, so
    // there's nothing to guarantee — reordering here would just be arbitrary.
    const rows = [row(1, null), row(2, 100), row(3, null)]
    expect(prioritizeServingSize(rows, 5)).toEqual(rows)
  })

  it('treats undefined the same as null', () => {
    const rows = [{ id: 1, serving_grams: undefined }, row(2, 100)]
    expect(prioritizeServingSize(rows, 1).map((r) => r.id)).toEqual([2, 1])
  })

  it('defaults its window to 5', () => {
    const rows = [
      row(1, 100), row(2, 100), row(3, 100), row(4, 100), row(5, 100),
      row(6, null),
      row(7, 100),
    ]
    // Already 5 serving-having rows lead, so nothing moves.
    expect(prioritizeServingSize(rows).map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('an empty list is a no-op', () => {
    expect(prioritizeServingSize([])).toEqual([])
  })
})

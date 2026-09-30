import { describe, expect, it } from 'vitest'
import { pickAxisValues } from '~/utils/axisTicks'

// Identity position: gaps are measured in the values' own units.
const id = (v: number) => v

describe('pickAxisValues', () => {
  it('labels every reading when they are far enough apart', () => {
    expect(pickAxisValues([80, 82, 84], id, 1)).toEqual([84, 82, 80])
  })

  it('only ever returns values that were measured', () => {
    const values = [81.3, 80.9, 80.2, 79.8, 80.5, 79.4]
    for (const v of pickAxisValues(values, id, 0.5)) expect(values).toContain(v)
  })

  it('keeps labels at least minGap apart', () => {
    const values = [80, 80.1, 80.2, 80.3, 81, 81.1, 82]
    const picked = pickAxisValues(values, id, 0.5)
    for (let i = 1; i < picked.length; i++) {
      expect(picked[i - 1]! - picked[i]!).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('always labels the latest reading, even between the extremes', () => {
    const picked = pickAxisValues([80, 90, 85.3], id, 3)
    expect(picked).toContain(85.3)
    expect(picked).toEqual([90, 85.3, 80])
  })

  it('prefers the latest over a crowding extreme', () => {
    // 80.2 is latest; 80 (the min) is too close to it and gets dropped.
    expect(pickAxisValues([80, 85, 80.2], id, 1)).toEqual([85, 80.2])
  })

  it('samples evenly rather than bunching', () => {
    const values = [70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80]
    // Ends first, then the middle; the quarters would be too close to both.
    expect(pickAxisValues(values, id, 2.5)).toEqual([80, 75, 70])
  })

  it('treats readings equal at display precision as one label', () => {
    expect(pickAxisValues([80.01, 80.04, 81], id, 0.5)).toEqual([81, 80])
  })

  it('handles a flat or empty series', () => {
    expect(pickAxisValues([75, 75, 75], id, 1)).toEqual([75])
    expect(pickAxisValues([], id, 1)).toEqual([])
  })

  it('respects the position mapping (inverted SVG y)', () => {
    const y = (v: number) => 100 - v * 10
    expect(pickAxisValues([1, 1.5, 2, 5], y, 8)).toEqual([5, 2, 1])
  })
})

import { describe, expect, it } from 'vitest'
import {
  activeTakeAt,
  applyKeepRanges,
  punchInOverwriteAmount,
  resolveTimeline,
  segmentsDuration,
  timelineDuration,
} from '../../shared/utils/timeline'

describe('resolveTimeline', () => {
  it('returns nothing for an empty take list', () => {
    expect(resolveTimeline([])).toEqual([])
  })

  it('returns the whole take when there is only one', () => {
    const segments = resolveTimeline([{ id: 'a', timelineStart: 0, duration: 10 }])
    expect(segments).toEqual([{ source: 'a', start: 0, end: 10 }])
  })

  it('keeps two back-to-back takes as separate contiguous segments', () => {
    const segments = resolveTimeline([
      { id: 'a', timelineStart: 0, duration: 10 },
      { id: 'b', timelineStart: 10, duration: 5 },
    ])
    expect(segments).toEqual([
      { source: 'a', start: 0, end: 10 },
      { source: 'b', start: 0, end: 5 },
    ])
  })

  it('lets a later punch-in take win over the range it overlaps', () => {
    // take a: 0-12s (the original take), take b: a punch-in from 8-10s
    const segments = resolveTimeline([
      { id: 'a', timelineStart: 0, duration: 12 },
      { id: 'b', timelineStart: 8, duration: 2 },
    ])
    expect(segments).toEqual([
      { source: 'a', start: 0, end: 8 },
      { source: 'b', start: 0, end: 2 },
      { source: 'a', start: 10, end: 12 },
    ])
  })

  it('lets a punch-in that fully covers an earlier take replace it entirely', () => {
    const segments = resolveTimeline([
      { id: 'a', timelineStart: 0, duration: 5 },
      { id: 'b', timelineStart: 0, duration: 5 },
    ])
    expect(segments).toEqual([{ source: 'b', start: 0, end: 5 }])
  })

  it('drops a range no take covers (a gap)', () => {
    const segments = resolveTimeline([
      { id: 'a', timelineStart: 0, duration: 5 },
      { id: 'b', timelineStart: 8, duration: 5 },
    ])
    // No take covers 5-8s, so it just isn't represented — not a crash, not a fabricated segment.
    expect(segments).toEqual([
      { source: 'a', start: 0, end: 5 },
      { source: 'b', start: 0, end: 5 },
    ])
  })
})

describe('timelineDuration / segmentsDuration', () => {
  it('is the furthest point any take reaches', () => {
    expect(timelineDuration([
      { id: 'a', timelineStart: 0, duration: 5 },
      { id: 'b', timelineStart: 3, duration: 2 },
    ])).toBe(5)
  })

  it('segmentsDuration sums segment lengths, not master-time span', () => {
    expect(segmentsDuration([
      { source: 'a', start: 0, end: 90 },
      { source: 'a', start: 200, end: 260 },
    ])).toBe(150)
  })
})

describe('activeTakeAt', () => {
  const takes = [
    { id: 'a', timelineStart: 0, duration: 10 },
    { id: 'b', timelineStart: 5, duration: 3 }, // punch-in covering 5-8s
  ]

  it('resolves to the punch-in take within its range', () => {
    expect(activeTakeAt(takes, 6)).toEqual({ id: 'b', localTime: 1 })
  })

  it('resolves to the base take outside the punch-in range', () => {
    expect(activeTakeAt(takes, 1)).toEqual({ id: 'a', localTime: 1 })
    expect(activeTakeAt(takes, 9)).toEqual({ id: 'a', localTime: 9 })
  })

  it('resolves the exact end boundary to whichever take ends there', () => {
    expect(activeTakeAt(takes, 10)).toEqual({ id: 'a', localTime: 10 })
  })

  it('returns null outside any take', () => {
    expect(activeTakeAt(takes, 100)).toBeNull()
  })
})

describe('punchInOverwriteAmount', () => {
  it('is zero once at or past the end', () => {
    const takes = [{ id: 'a', timelineStart: 0, duration: 10 }]
    expect(punchInOverwriteAmount(takes, 10)).toBe(0)
    expect(punchInOverwriteAmount(takes, 15)).toBe(0)
  })

  it('is the remaining duration when scrubbed mid-recording', () => {
    const takes = [{ id: 'a', timelineStart: 0, duration: 10 }]
    expect(punchInOverwriteAmount(takes, 7)).toBeCloseTo(3)
  })
})

describe('applyKeepRanges', () => {
  const original = [{ source: 'take-1', start: 0, end: 100 }]

  it('trims the start', () => {
    expect(applyKeepRanges(original, [{ start: 10, end: 100 }])).toEqual([
      { source: 'take-1', start: 10, end: 100 },
    ])
  })

  it('trims the end', () => {
    expect(applyKeepRanges(original, [{ start: 0, end: 80 }])).toEqual([
      { source: 'take-1', start: 0, end: 80 },
    ])
  })

  it('crops the middle out (keep first 90s and last 60s of a 200s master)', () => {
    const master = [{ source: 'take-1', start: 0, end: 200 }]
    const result = applyKeepRanges(master, [
      { start: 0, end: 90 },
      { start: 140, end: 200 },
    ])
    expect(result).toEqual([
      { source: 'take-1', start: 0, end: 90 },
      { source: 'take-1', start: 140, end: 200 },
    ])
  })

  it('maps a keep-range spanning multiple existing segments back onto each source', () => {
    // master built from two takes: take-1 for the first 90s, take-2 for the next 60s
    const master = [
      { source: 'take-1', start: 0, end: 90 },
      { source: 'take-2', start: 83, end: 143 },
    ]
    // keep 80-100 of the master: 10s from the tail of take-1, 10s from the head of take-2
    const result = applyKeepRanges(master, [{ start: 80, end: 100 }])
    expect(result).toEqual([
      { source: 'take-1', start: 80, end: 90 },
      { source: 'take-2', start: 83, end: 93 },
    ])
  })

  it('is a no-op when the keep range is the whole thing', () => {
    expect(applyKeepRanges(original, [{ start: 0, end: 100 }])).toEqual(original)
  })
})

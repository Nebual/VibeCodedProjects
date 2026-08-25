import type { KeepRange } from '#shared/types'

export interface TimelineTake {
  id: string
  timelineStart: number
  duration: number
}

export interface ResolvedSegment {
  source: string
  start: number
  end: number
}

/**
 * Resolves a stack of takes into a flat segment list where later takes (higher
 * index) win wherever they overlap earlier ones. Mirrors the punch-in model:
 * take 1 is the original recording, later takes are overdubs recorded after
 * seeking back into it. Used both for the client-side review scrubber and to
 * build a song's initial edit_list on the server.
 */
export function resolveTimeline(takes: TimelineTake[]): ResolvedSegment[] {
  if (takes.length === 0) return []

  const breakpoints = new Set<number>()
  for (const t of takes) {
    breakpoints.add(t.timelineStart)
    breakpoints.add(t.timelineStart + t.duration)
  }
  const sorted = [...breakpoints].sort((a, b) => a - b)

  const raw: { start: number, end: number, takeIndex: number }[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]!
    const end = sorted[i + 1]!
    if (end - start <= 0) continue

    let winner = -1
    for (let ti = 0; ti < takes.length; ti++) {
      const t = takes[ti]!
      if (t.timelineStart <= start && start < t.timelineStart + t.duration) {
        winner = ti
      }
    }
    if (winner === -1) continue // gap: no take covers this range
    raw.push({ start, end, takeIndex: winner })
  }

  const merged: { start: number, end: number, takeIndex: number }[] = []
  for (const seg of raw) {
    const last = merged[merged.length - 1]
    if (last && last.takeIndex === seg.takeIndex && last.end === seg.start) {
      last.end = seg.end
    } else {
      merged.push({ ...seg })
    }
  }

  return merged.map((seg) => {
    const take = takes[seg.takeIndex]!
    return {
      source: take.id,
      start: seg.start - take.timelineStart,
      end: seg.end - take.timelineStart,
    }
  })
}

export function timelineDuration(takes: TimelineTake[]): number {
  return takes.reduce((max, t) => Math.max(max, t.timelineStart + t.duration), 0)
}

/** Which take covers an absolute timeline position, and where within that take. */
export function activeTakeAt(takes: TimelineTake[], position: number): { id: string, localTime: number } | null {
  let winner: TimelineTake | null = null
  for (const t of takes) {
    if (t.timelineStart <= position && position < t.timelineStart + t.duration) {
      winner = t
    }
  }
  if (!winner) {
    for (const t of takes) {
      if (Math.abs(t.timelineStart + t.duration - position) < 0.001) winner = t
    }
  }
  if (!winner) return null
  return { id: winner.id, localTime: position - winner.timelineStart }
}

/** How much existing audio a punch-in starting at `scrubPosition` would overwrite. */
export function punchInOverwriteAmount(takes: TimelineTake[], scrubPosition: number): number {
  const total = timelineDuration(takes)
  return Math.max(0, total - scrubPosition)
}

/**
 * Which segment covers a position in the concatenated (master-time) timeline a `ResolvedSegment[]`
 * renders to, and where within that segment's own source take. Mirrors `activeTakeAt`, but over
 * already-resolved segments rather than a raw take stack — used to map a UI position (e.g. an
 * ambience-region or cursor position, expressed in the full timeline shown to the user) back onto
 * the actual take file + local offset a server-side render needs to read from.
 */
export function resolveSegmentPosition(segments: ResolvedSegment[], position: number): { source: string, localTime: number } | null {
  let cursor = 0
  for (const seg of segments) {
    const len = seg.end - seg.start
    if (position >= cursor && position < cursor + len) {
      return { source: seg.source, localTime: seg.start + (position - cursor) }
    }
    cursor += len
  }
  const last = segments[segments.length - 1]
  if (last && Math.abs(cursor - position) < 0.001) {
    return { source: last.source, localTime: last.end }
  }
  return null
}

/** Total duration a segment list renders to (sum of each segment's own length). */
export function segmentsDuration(segments: ResolvedSegment[]): number {
  return segments.reduce((sum, s) => sum + (s.end - s.start), 0)
}

/**
 * Re-expresses a keep-only selection of the CURRENT rendered master's
 * timeline back in terms of the segments that produced it. This is the one
 * mechanism behind trim-start, trim-end, and crop-the-middle: all three are
 * just "keep these ranges of the master," and this maps those ranges back
 * onto whichever take each already-resolved segment came from.
 */
export function applyKeepRanges(segments: ResolvedSegment[], keepRanges: KeepRange[]): ResolvedSegment[] {
  const bounds: { segment: ResolvedSegment, masterStart: number, masterEnd: number }[] = []
  let cursor = 0
  for (const segment of segments) {
    const len = segment.end - segment.start
    bounds.push({ segment, masterStart: cursor, masterEnd: cursor + len })
    cursor += len
  }

  const sortedRanges = [...keepRanges].sort((a, b) => a.start - b.start)
  const result: ResolvedSegment[] = []

  for (const range of sortedRanges) {
    for (const b of bounds) {
      const overlapStart = Math.max(range.start, b.masterStart)
      const overlapEnd = Math.min(range.end, b.masterEnd)
      if (overlapEnd - overlapStart <= 0) continue
      const localOffset = overlapStart - b.masterStart
      result.push({
        source: b.segment.source,
        start: b.segment.start + localOffset,
        end: b.segment.start + localOffset + (overlapEnd - overlapStart),
      })
    }
  }

  return result
}

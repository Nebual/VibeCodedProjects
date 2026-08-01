import { MEDIA_STATUSES, MEDIA_TYPES, ratingFor } from '~~/shared/types'
import type { MediaItem } from '~~/shared/types'

// Shared by the sort dropdown (cards view) and the sortable table headers, so
// both write to one piece of state and can never disagree.
export type SortKey =
  | 'recent'
  | 'title'
  | 'type'
  | 'status'
  | 'people'
  | 'group'
  | 'stars'

export type SortDir = 'asc' | 'desc'

/** Direction a column starts in when you first click it. */
export const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  recent: 'desc', // most recently active first
  title: 'asc', // A-Z
  type: 'asc',
  status: 'asc',
  people: 'desc', // biggest group first
  group: 'desc',
  stars: 'desc', // best rated first
}

export const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Last active',
  title: 'Title',
  type: 'Type',
  status: 'Status',
  people: 'With',
  group: 'Group',
  stars: 'Rating',
}

const typeRank = (m: MediaItem) => MEDIA_TYPES.indexOf(m.type)
const statusRank = (m: MediaItem) => MEDIA_STATUSES.indexOf(m.status)
const activityOf = (m: MediaItem) => m.lastActivityAt || m.createdAt

/**
 * Ascending comparison for a single key. Direction is applied by the caller.
 * `viewer` decides whose rating the `stars` key uses — your own if you wrote
 * one, otherwise the average across everyone.
 */
export function compareMedia(
  a: MediaItem,
  b: MediaItem,
  key: SortKey,
  viewer = '',
): number {
  switch (key) {
    case 'title':
      return a.title.localeCompare(b.title)
    case 'type':
      return typeRank(a) - typeRank(b)
    case 'status':
      return statusRank(a) - statusRank(b)
    case 'people':
      return a.companions.length - b.companions.length
    case 'group':
      return (a.minPlayers ?? 0) - (b.minPlayers ?? 0)
    case 'stars':
      return ratingFor(a, viewer) - ratingFor(b, viewer)
    case 'recent':
    default:
      return activityOf(a).localeCompare(activityOf(b))
  }
}

/**
 * Sort a copy of `list`.
 *
 * `primary` is an optional higher-priority ranking applied descending before
 * the chosen column — the friend filter uses it so best-matching media stays on
 * top regardless of which column you're sorting by.
 */
export function sortMedia(
  list: MediaItem[],
  key: SortKey,
  dir: SortDir,
  opts: { primary?: (item: MediaItem) => number; viewer?: string } = {},
): MediaItem[] {
  const { primary, viewer = '' } = opts
  const sign = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    if (primary) {
      const p = primary(b) - primary(a)
      if (p !== 0) return p
    }
    const c = compareMedia(a, b, key, viewer)
    if (c !== 0) return c * sign
    // Stable, predictable tie-break so equal rows don't shuffle around.
    return a.title.localeCompare(b.title)
  })
}

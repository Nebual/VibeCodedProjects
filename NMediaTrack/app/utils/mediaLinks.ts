import type { MediaItem, MediaType } from '~~/shared/types'

// Media types that have an obvious "go look this up" destination. The site name
// is prepended to the search so the first hit is the store/catalogue page.
const LOOKUP_SITE: Partial<Record<MediaType, string>> = {
  game: 'Steam',
  book: 'Goodreads',
}

/**
 * DuckDuckGo "Feeling Ducky" URL — a leading backslash redirects straight to
 * the first result. Preferred over Google's `btnI`, which modern Google
 * frequently ignores and drops you on the results page instead.
 *
 * Returns null for types with no sensible lookup target.
 */
export function lookupUrl(item: Pick<MediaItem, 'type' | 'title'>): string | null {
  const site = LOOKUP_SITE[item.type]
  if (!site || !item.title.trim()) return null
  const q = encodeURIComponent(`\\${site} ${item.title.trim()}`)
  return `https://duckduckgo.com/?q=${q}`
}

/** Tooltip for the lookup link, e.g. "Look up on Steam". */
export function lookupLabel(item: Pick<MediaItem, 'type'>): string {
  const site = LOOKUP_SITE[item.type]
  return site ? `Look up on ${site}` : ''
}

/**
 * Calendar-day helpers.
 *
 * The diary is keyed by the user's *local* calendar day. Deriving that from
 * `toISOString()` would silently shift the day for anyone west of UTC after
 * their afternoon — food logged at 7pm would land on tomorrow's page.
 */

/** 'YYYY-MM-DD' for a Date in the *running process's* timezone. */
export function toLocalDate(d: Date = new Date()): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Today's calendar date in an explicit IANA timezone.
 *
 * Server and browser must agree on which day it is, and they frequently don't:
 * a host in UTC and a phone in Toronto disagree for five hours every evening.
 * Passing the timezone explicitly makes the answer identical in both places.
 *
 * 'en-CA' is used purely because it formats as YYYY-MM-DD.
 */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  } catch {
    // An unknown zone (some locked-down browsers report 'Etc/Unknown').
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  }
}

/** Parse 'YYYY-MM-DD' as local midnight (not UTC midnight). */
export function fromLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

export function addDays(iso: string, delta: number): string {
  const d = fromLocalDate(iso)
  d.setDate(d.getDate() + delta)
  return toLocalDate(d)
}

/** "Today", "Yesterday", or e.g. "Sat 14 Jun", relative to a known today. */
export function humanDate(iso: string, today: string): string {
  if (iso === today) return 'Today'
  if (iso === addDays(today, -1)) return 'Yesterday'
  if (iso === addDays(today, 1)) return 'Tomorrow'

  const d = fromLocalDate(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

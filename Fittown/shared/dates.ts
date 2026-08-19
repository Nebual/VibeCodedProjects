/**
 * Calendar-day arithmetic, shared by the server and the UI.
 *
 * Pure date-only math — no timezone lookups — so it's safe to run on the
 * server (e.g. finding "the 7 days before this one" for a weekly rollup)
 * without knowing the user's local timezone the way `todayIn` does.
 */

/** 'YYYY-MM-DD' for a Date in the *running process's* timezone. */
export function toLocalDate(d: Date = new Date()): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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

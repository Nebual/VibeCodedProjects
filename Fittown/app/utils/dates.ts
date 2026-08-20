/**
 * Calendar-day helpers.
 *
 * The diary is keyed by the user's *local* calendar day. Deriving that from
 * `toISOString()` would silently shift the day for anyone west of UTC after
 * their afternoon — food logged at 7pm would land on tomorrow's page.
 *
 * `toLocalDate`/`fromLocalDate`/`addDays` live in `#shared/dates` so the
 * server can reuse the same day arithmetic; re-exported here so existing
 * `~/utils/dates` imports keep working.
 */
import { addDays, fromLocalDate, toLocalDate } from '#shared/dates'
export { addDays, fromLocalDate, toLocalDate }

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

/** "Today", "Yesterday", or e.g. "Sat 14 Jun", relative to a known today. */
export function humanDate(iso: string, today: string): string {
  const weekday = fromLocalDate(iso).toLocaleDateString(undefined, { weekday: 'short' })
  if (iso === today) return `Today (${weekday})`
  if (iso === addDays(today, -1)) return `Yesterday (${weekday})`
  if (iso === addDays(today, 1)) return `Tomorrow (${weekday})`

  const d = fromLocalDate(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** The hour (0–23) right now in an explicit IANA timezone. */
export function hourIn(timeZone: string, now: Date = new Date()): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now),
    )
  } catch {
    return now.getHours()
  }
}

/**
 * The day the diary *means* by "today".
 *
 * Between midnight and 3am someone finishing their evening isn't starting a new
 * day yet — they're logging food that belongs on yesterday's page. So during
 * that window the effective diary day is yesterday; otherwise it is today.
 */
export function diaryDayIn(timeZone: string, now: Date = new Date()): string {
  const today = todayIn(timeZone, now)
  return hourIn(timeZone, now) < 3 ? addDays(today, -1) : today
}

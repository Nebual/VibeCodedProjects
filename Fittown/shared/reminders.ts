/**
 * Reminder recurrence rules — pure logic shared by the Nitro API (which stores
 * and evaluates schedules) and the diary UI (which labels them).
 *
 * A reminder has a *versioned* schedule history: each edit appends a row that
 * takes effect from a given day. Evaluating a past day uses the newest
 * schedule whose `effective_from` is on or before that day, which is what
 * makes "moved Garbage from every-other-Thursday to every-other-Friday" leave
 * the past on Thursdays untouched.
 */

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export type ReminderFreq = 'daily' | 'weekly' | 'monthly'

/** One point in a reminder's schedule history, as stored in reminder_schedules. */
export interface ReminderScheduleRule {
  /** Day the rule starts applying, 'YYYY-MM-DD'. Doubles as the week anchor. */
  effective_from: string
  freq: ReminderFreq
  /** Weeks between occurrences, weekly-type only (1 = every week). */
  interval: number
  /** 0 = Sunday … 6 = Saturday. Empty for daily/monthly. */
  byweekday: number[]
  /** 1–31, monthly only. Months without that day simply have no occurrence. */
  day_of_month: number | null
}

const MS_PER_DAY = 86_400_000

function utcMidnight(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

/** Day of week (0=Sun…6=Sat) of a 'YYYY-MM-DD' string. */
export function weekdayOf(iso: string): number {
  return new Date(utcMidnight(iso)).getUTCDay()
}

/** Day of month (1–31) of a 'YYYY-MM-DD' string. */
export function dayOfMonthOf(iso: string): number {
  return Number(iso.split('-')[2])
}

/**
 * Does one schedule rule produce an occurrence on `iso`?
 * Assumes the caller already picked the rule in force on that day.
 */
export function occursOn(rule: ReminderScheduleRule, iso: string): boolean {
  if (iso < rule.effective_from) return false

  if (rule.freq === 'daily') return true

  if (rule.freq === 'weekly') {
    if (!rule.byweekday.includes(weekdayOf(iso))) return false
    const weeks = Math.floor((utcMidnight(iso) - utcMidnight(rule.effective_from)) / MS_PER_DAY / 7)
    return weeks % rule.interval === 0
  }

  // monthly. A 31st (or 30th/29th) that a month doesn't have is skipped, not
  // clamped — "the 31st" happening on the 30th would surprise the user more
  // than a short month quietly having no occurrence.
  return rule.day_of_month !== null && dayOfMonthOf(iso) === rule.day_of_month
}

/** Short human label for the rule, or null for plain daily (no label needed). */
export function describeSchedule(rule: ReminderScheduleRule): string | null {
  const days = [...rule.byweekday].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]!)
  if (rule.freq === 'weekly') {
    if (rule.interval === 1) {
      return days.length > 1 ? `Weekly on ${days.join(' & ')}` : `Weekly on ${days[0]}`
    }
    return `Every ${rule.interval} weeks on ${days.join(' & ')}`
  }
  if (rule.freq === 'monthly') {
    return `Monthly on the ${rule.day_of_month}${ordinalSuffix(rule.day_of_month ?? 0)}`
  }
  return null
}

function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th'
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'
}

/** Validate an incoming rule body; returns the normalized rule or an error message. */
export function normalizeSchedule(input: {
  freq: unknown
  interval?: unknown
  byweekday?: unknown
  day_of_month?: unknown
}): { ok: true; rule: Omit<ReminderScheduleRule, 'effective_from'> } | { ok: false; error: string } {
  const freq = input.freq
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly') {
    return { ok: false, error: 'freq must be daily, weekly or monthly' }
  }

  let interval = 1
  if (freq === 'weekly') {
    const n = typeof input.interval === 'string' ? Number(input.interval) : input.interval
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 52) {
      return { ok: false, error: 'interval must be 1–52 weeks' }
    }
    interval = n
  }

  let byweekday: number[] = []
  if (freq === 'weekly') {
    if (
      !Array.isArray(input.byweekday)
      || input.byweekday.length === 0
      || !input.byweekday.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    ) {
      return { ok: false, error: 'byweekday must be a non-empty list of 0–6' }
    }
    byweekday = [...new Set(input.byweekday as number[])].sort((a, b) => a - b)
  }

  let dayOfMonth: number | null = null
  if (freq === 'monthly') {
    const n = typeof input.day_of_month === 'string' ? Number(input.day_of_month) : input.day_of_month
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 31) {
      return { ok: false, error: 'day_of_month must be 1–31' }
    }
    dayOfMonth = n
  }

  return { ok: true, rule: { freq, interval, byweekday, day_of_month: dayOfMonth } }
}

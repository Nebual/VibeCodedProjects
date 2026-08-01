// Human-friendly relative time, e.g. "3 days ago", "just now", "2 months ago".
export function timeAgo(iso?: string): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const secs = Math.round((Date.now() - then) / 1000)
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.round(months / 12)
  return `${years} year${years === 1 ? '' : 's'} ago`
}

/** Days since a timestamp; used to flag "stale" media worth revisiting. */
export function daysSince(iso?: string): number {
  if (!iso) return Infinity
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return Infinity
  return (Date.now() - then) / (1000 * 60 * 60 * 24)
}

/** ISO timestamp -> "YYYY-MM-DD" for an <input type="date">, in local time. */
export function toDateInput(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * "YYYY-MM-DD" -> ISO timestamp. Past dates are anchored at local midday rather
 * than midnight so they can't slip a day across timezones or DST transitions.
 * Today resolves to the current time, so picking it reads as "just now" instead
 * of drifting hours away from the clock.
 */
export function fromDateInput(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const now = new Date()
  const date = new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, 0)
  if (Number.isNaN(date.getTime())) return null
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return (isToday ? now : date).toISOString()
}

/** Today as "YYYY-MM-DD", for date-input defaults and max bounds. */
export function todayInput(): string {
  return toDateInput(new Date().toISOString())
}

/** A short absolute date like "30 Jul 2026". */
export function shortDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds)
  const minutes = Math.floor(s / 60)
  const secs = s - minutes * 60
  return `${minutes}:${secs.toFixed(1).padStart(4, '0')}`
}

/** Formats in UTC (not the viewer's local time zone) so SSR and client hydration always agree. */
export function formatDate(value: string | number | Date): string {
  return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

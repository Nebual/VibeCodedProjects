/** Short, glanceable relative time — "4m", "3h", "2d" — for the item subtitles. */
export function relativeTime(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return 'just now'

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`

  const weeks = Math.round(days / 7)
  if (weeks < 9) return `${weeks}w ago`

  return `${Math.round(days / 30)}mo ago`
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds)
  const minutes = Math.floor(s / 60)
  const secs = s - minutes * 60
  return `${minutes}:${secs.toFixed(1).padStart(4, '0')}`
}

/**
 * The six primals, plus Praecantatio — pinned to the front of the grid in every
 * sort mode so they always sit in a known spot.
 */
const PINNED = ['aer', 'terra', 'ignis', 'aqua', 'ordo', 'perditio', 'praecantatio']

export type SortMode = 'amount' | 'name'

export function essentiaIcon(name: string): string {
  return `/icons/essentia/${name.toLowerCase()}.png`
}

/**
 * Stable display order, so the grid never reshuffles just because an incoming
 * POST listed its entries differently. Pinned aspects keep their canonical
 * order regardless of mode; the rest sort by amount (descending) or by name.
 * Items have no pinned names, so they just sort.
 */
export function sortStock<T extends { name: string, amount: number }>(
  entries: T[],
  mode: SortMode = 'amount',
): T[] {
  return [...entries].sort((a, b) => {
    const left = a.name.toLowerCase()
    const right = b.name.toLowerCase()
    const leftPinned = PINNED.indexOf(left)
    const rightPinned = PINNED.indexOf(right)

    if (leftPinned !== -1 || rightPinned !== -1) {
      if (rightPinned === -1) return -1
      if (leftPinned === -1) return 1
      return leftPinned - rightPinned
    }

    if (mode === 'amount' && a.amount !== b.amount) {
      return b.amount - a.amount
    }
    return left.localeCompare(right)
  })
}

/** Re-key a target map by lowercase name, so lookups tolerate casing differences. */
export function byLowerName(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).map(([name, value]) => [name.toLowerCase(), value]))
}

/** Keeps large stock counts inside a small tile: 4,000 stays exact, 1,240,000 becomes 1.24M. */
export function formatAmount(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  }
  if (Math.abs(amount) >= 100_000) {
    return `${(amount / 1_000).toFixed(0)}k`
  }
  return amount.toLocaleString('en-US')
}

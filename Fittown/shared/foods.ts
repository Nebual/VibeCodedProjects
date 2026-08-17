/** How many leading search-result slots must have a serving size, if that many exist. */
export const SERVING_PRIORITY_WINDOW = 5

/**
 * Push generic foods (no `serving_grams`) out of the first `window` search
 * results, if enough foods with one exist to fill it.
 *
 * A food with no serving size can't offer "1 serving" in the portion picker —
 * only grams, or a 100 g pseudo-unit — so it's a worse hit than an otherwise
 * equal match that has one. This is a stable partial reorder, not a full
 * re-sort: it guarantees the fold, then leaves the caller's relevance order
 * alone for everything after, so a strong generic match still surfaces just
 * past position `window` rather than being banished to the end. When fewer
 * than `window` foods with a serving size exist at all, the list is returned
 * unchanged — there's nothing to fill the guarantee with.
 */
export function prioritizeServingSize<T extends { serving_grams: unknown }>(
  results: T[],
  window: number = SERVING_PRIORITY_WINDOW,
): T[] {
  const head: T[] = []
  for (const row of results) {
    if (row.serving_grams !== null && row.serving_grams !== undefined) head.push(row)
    if (head.length >= window) break
  }
  if (head.length < window) return results

  const headSet = new Set(head)
  const rest = results.filter((row) => !headSet.has(row))
  return [...head, ...rest]
}

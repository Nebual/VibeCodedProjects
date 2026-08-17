/**
 * Where a picked food is headed.
 *
 * Choosing a food is one journey — search, scan, recent, portion — with two
 * destinations: a meal in the diary, or a recipe's ingredient list. The
 * difference is carried in the query string so every screen in between
 * (results, scanner, "create a custom food") can pass it along without knowing
 * anything about it.
 */
export function foodLinkQuery(options: {
  meal?: string | null
  date?: string | null
  recipe?: number | null
  /**
   * Set when the picked food is going to *replace* an ingredient that already
   * exists — how an imported line with no food attached gets one.
   */
  ingredient?: number | null
  extra?: Record<string, string>
}): string {
  const params = new URLSearchParams()

  if (options.recipe) {
    params.set('recipe', String(options.recipe))
    if (options.ingredient) params.set('ingredient', String(options.ingredient))
  } else {
    if (options.meal) params.set('meal', options.meal)
    // Omitted entirely rather than sent as "null", which the API rejects.
    if (options.date) params.set('d', options.date)
  }

  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value) params.set(key, value)
  }

  return params.toString()
}

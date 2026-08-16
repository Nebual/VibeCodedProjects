import { NUTRIENT_KEYS } from '#shared/nutrients'

const FOOD_FIELDS = [
  'id', 'source', 'barcode', 'name', 'brand', 'quantity', 'categories',
  'image_url', 'serving_size_text', 'serving_grams', 'is_liquid',
  'owner_user_id', 'nutriscore', 'nova_group', 'popularity',
  ...NUTRIENT_KEYS,
]

/**
 * Food columns for a SELECT, qualified by table alias.
 *
 * Always qualified: several of these names (`id`, `created_at`) also exist on
 * `diary_entries`, and an unqualified list makes those joins ambiguous.
 */
export function foodCols(alias = 'f'): string {
  return FOOD_FIELDS.map((c) => `${alias}.${c}`).join(', ')
}

/**
 * Turn free text into an FTS5 MATCH expression.
 *
 * FTS5 treats a lot of punctuation as syntax, so anything that isn't a letter,
 * digit or space is stripped rather than escaped — users type "Ben & Jerry's",
 * not a query language. Each term gets a prefix wildcard so results appear
 * while they're still typing.
 */
export function buildFtsQuery(input: string): string | null {
  const terms = input
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 8)

  if (terms.length === 0) return null
  return terms.map((t) => `"${t}"*`).join(' AND ')
}

/**
 * Rank search results.
 *
 * FTS5's `rank` alone puts obscure products above household names, so it's
 * blended with several signals:
 *  - the user's own foods always win;
 *  - an exact or near-exact name match beats a partial one, which is what
 *    stops a novelty product called "Bananahh!" outranking plain "Banana";
 *  - scan popularity, log-damped since it spans several orders of magnitude;
 *  - a mild penalty for very long names, which in OFF are usually marketing
 *    strings rather than the thing you actually searched for.
 */
export const SEARCH_SCORE = `
  (f.owner_user_id IS NOT NULL) * 100
  + (foods_fts.rank * -1)
  + (CASE WHEN LOWER(f.name) = LOWER($exact) THEN 8 ELSE 0 END)
  + (CASE WHEN LOWER(f.name) LIKE LOWER($exact) || '%' THEN 3 ELSE 0 END)
  + (LOG(1 + COALESCE(f.popularity, 0)) * 0.6)
  - (LENGTH(f.name) / 60.0)
`

/**
 * How many raw FTS hits to score before de-duplicating.
 *
 * OFF holds many near-identical rows per product, so de-duplication has to
 * happen before the page limit or a search for a popular cereal returns one
 * result instead of a screenful. Capping the scored set keeps a broad term
 * like "chicken" from ranking tens of thousands of rows on every keystroke.
 */
export const SEARCH_SCAN_LIMIT = 600

/** Unqualified column list, for selecting back out of a CTE. */
export function foodColsBare(): string {
  return FOOD_FIELDS.join(', ')
}

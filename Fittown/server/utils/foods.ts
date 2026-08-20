import type { DatabaseSync } from 'node:sqlite'
import { NUTRIENT_KEYS } from '#shared/nutrients'
import { RECIPE_LOG_SOURCE } from '#shared/recipes'

const FOOD_FIELDS = [
  'id', 'source', 'barcode', 'name', 'brand', 'quantity', 'categories',
  'image_url', 'serving_size_text', 'serving_grams', 'is_liquid',
  'owner_user_id', 'nutriscore', 'nova_group', 'popularity',
  // Recipe fields travel with the food so that search results, the diary and
  // the portion picker can all apply the "no yield, no gram portions" rule
  // without a second query. Null for everything that isn't a recipe.
  'recipe_servings', 'recipe_final_weight_g',
  // A frozen meal carries where it came from and what was changed, so the
  // diary can link back to the recipe and say "3 × egg instead of 4" without
  // a second query. Null on everything else, which is almost every row.
  'logged_from_food_id', 'recipe_log_note', 'recipe_family_id',
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
 *  - USDA Foundation Foods (lab-analysed generic ingredients) are preferred
 *    over OFF's crowd-sourced data for the same food. FDC's names spell out
 *    every variant ("Milk, reduced fat, fluid, 2% milkfat, with added
 *    vitamin A and vitamin D"), which reads as a much weaker FTS match than
 *    OFF's terse "Milk" and would otherwise lose despite being the better
 *    data — so the bonus is calibrated to clear even that worst case against
 *    OFF's best case (an exact-name match with this dataset's highest
 *    popularity), not just a typical one;
 *  - USDA Branded Foods gets only a *slight* nudge (+3, vs. Foundation's
 *    +20) — a real investigation into overlapping barcodes found neither
 *    source is clearly better (both have their own data errors), so this is
 *    a mild tiebreaker for comparably-relevant hits, not a guaranteed win;
 *    a popular OFF product's own popularity bonus can still outrank it;
 *  - scan popularity, log-damped since it spans several orders of magnitude;
 *  - a mild penalty for very long names, which in OFF are usually marketing
 *    strings rather than the thing you actually searched for.
 */
export const SEARCH_SCORE = `
  (f.owner_user_id IS NOT NULL) * 100
  + (foods_fts.rank * -1)
  + (CASE WHEN LOWER(f.name) = LOWER($exact) THEN 8 ELSE 0 END)
  + (CASE WHEN LOWER(f.name) LIKE LOWER($exact) || '%' THEN 3 ELSE 0 END)
  + (CASE WHEN f.source = 'usda_foundation' THEN 20 ELSE 0 END)
  + (CASE WHEN f.source = 'usda_branded' THEN 3 ELSE 0 END)
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

/**
 * A user's own (source = 'custom') foods, alphabetical — what a friend's Custom
 * foods tab shows, and what the owner's own food library is built from.
 *
 * `kcal` and `serving_grams` are null on a food that has no nutrition recorded
 * yet; the UI must render "not recorded" rather than treating a null as 0.
 */
export function listCustomFoods(
  db: DatabaseSync,
  userId: number,
): (Record<string, unknown> & { serving_grams: number | null; kcal: number | null })[] {
  return db
    .prepare(
      `SELECT ${foodCols()}
       FROM foods f
       WHERE f.owner_user_id = ? AND f.source = 'custom'
       ORDER BY f.name COLLATE NOCASE`,
    )
    .all(userId) as (Record<string, unknown> & {
    serving_grams: number | null
    kcal: number | null
  })[]
}

/**
 * Foods this user logs most, newest-first among equals.
 *
 * Lives here rather than in the route because of the join below, which is the
 * one place in the app that has to see through a frozen meal to the recipe it
 * came from — worth a test of its own, and a route handler can't be called
 * from one.
 *
 * `logged` is the row the diary entry points at; `f` is what the user thinks
 * they ate. For a plain food they are the same row. For a logged recipe they
 * are not: thirty dinners are thirty snapshots, and grouping by the snapshot
 * would offer thirty "eaten once" omelettes instead of one recipe eaten thirty
 * times. Offering `f` back also means tapping it logs a *fresh* snapshot of the
 * recipe as it stands today, rather than re-using a frozen one.
 */
export function listFrequentFoods(
  db: DatabaseSync,
  userId: number,
  meal?: string | null,
  limit = 40,
  /**
   * Food ids this screen may not offer — when picking an ingredient, the recipe
   * itself and anything that already contains it. Frequent is the one list that
   * would otherwise hand back a cycle, since it is built from what you eat
   * rather than from what you searched for.
   */
  exclude: number[] = [],
) {
  const mealFilter = meal ? 'AND d.meal = ?' : ''
  // Interpolated rather than bound: the list is ids this function derived, and
  // node:sqlite has no array binding. Coerced to integers on the way in.
  const excludeFilter = exclude.length
    ? `AND f.id NOT IN (${exclude.map((id) => Number(id) || 0).join(',')})`
    : ''
  const params: unknown[] = [userId, RECIPE_LOG_SOURCE]
  if (meal) params.push(meal)

  return db
    .prepare(
      `SELECT ${foodCols()},
              COUNT(*) AS times_logged,
              MAX(d.created_at) AS last_logged,
              d.grams AS last_grams,
              d.serving_label AS last_serving_label,
              d.serving_count AS last_serving_count
       FROM diary_entries d
       JOIN foods logged ON logged.id = d.food_id
       JOIN foods f ON f.id = COALESCE(logged.logged_from_food_id, logged.id)
       -- Only reachable once the recipe behind a snapshot has been deleted (the
       -- pointer is ON DELETE SET NULL). There is nothing to offer then, so the
       -- row drops out rather than resurfacing a meal that can't be logged.
       WHERE d.user_id = ? AND f.source != ? ${mealFilter} ${excludeFilter}
       GROUP BY f.id
       ORDER BY times_logged DESC, last_logged DESC
       LIMIT ${Number(limit) || 40}`,
    )
    .all(...params)
}

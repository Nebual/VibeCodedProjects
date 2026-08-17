import { RECIPE_SOURCE } from '#shared/recipes'
import { friendIds } from '../../utils/friends'
import {
  buildFtsQuery,
  foodCols,
  foodColsBare,
  SEARCH_SCAN_LIMIT,
  SEARCH_SCORE,
} from '../../utils/foods'

/** A friend's recipes are a courtesy, not the point of the screen. */
const FRIEND_RESULT_LIMIT = 12

/**
 * Query flags arrive as strings, and `'0'` is truthy in JavaScript.
 *
 * A caller passing `exclude_recipes=0` to mean "no, include them" would
 * otherwise get the opposite of what it asked for — the kind of bug that only
 * shows up as a section mysteriously never appearing.
 */
function isTrue(value: unknown): boolean {
  return value !== undefined && value !== null
    && value !== '' && value !== '0' && value !== 'false' && value !== false
}

/**
 * Search the local food database.
 *
 * Custom foods belonging to the caller are always visible; OFF products are
 * shared. Results are de-duplicated by name+brand — OFF holds many
 * near-identical entries per product — keeping the best-scoring one of each.
 *
 * Friends' recipes come back in a *separate* list rather than mixed into the
 * ranking. Two reasons: the screen shows them under their own heading below
 * your own results, and they are not directly loggable — tapping one opens the
 * friend's recipe, which offers to copy it. Blending them into `results` would
 * put rows in the list that the portion picker can't accept.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { q, limit, exclude_recipes: excludeRecipes } = getQuery(event)

  const text = typeof q === 'string' ? q.trim() : ''
  if (text.length < 2) return { results: [], friend_results: [] }

  const match = buildFtsQuery(text)
  if (!match) return { results: [], friend_results: [] }

  const want = Math.min(Number(limit) || 30, 60)
  const db = useDb()

  // `exclude_recipes` means "I am picking an ingredient", which is the one
  // context where neither your recipes nor a friend's can be the answer.
  const pickingIngredient = isTrue(excludeRecipes)

  const results = db
    .prepare(
      `WITH scored AS (
         SELECT ${foodCols()}, ${SEARCH_SCORE} AS score
         FROM foods_fts
         JOIN foods f ON f.id = foods_fts.rowid
         WHERE foods_fts MATCH $match
           AND (f.owner_user_id IS NULL OR f.owner_user_id = $userId)
           AND ($includeRecipes = 1 OR f.source != $recipeSource)
         ORDER BY score DESC
         LIMIT $scan
       ),
       ranked AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY LOWER(name), LOWER(COALESCE(brand, ''))
           ORDER BY score DESC
         ) AS dup_rank
         FROM scored
       )
       SELECT ${foodColsBare()}
       FROM ranked
       WHERE dup_rank = 1
       ORDER BY score DESC
       LIMIT $limit`,
    )
    .all({
      match,
      userId: user.id,
      // Raw text, for the exact-match ranking bonus.
      exact: text,
      scan: SEARCH_SCAN_LIMIT,
      limit: want,
      // Recipes are ordinary foods everywhere except when picking an
      // *ingredient*, where one recipe can't yet be nested inside another.
      includeRecipes: pickingIngredient ? 0 : 1,
      recipeSource: RECIPE_SOURCE,
    })

  return {
    results,
    // Nothing to offer when we're picking an ingredient: a recipe can't be one,
    // and a friend's recipe is still a recipe.
    friend_results: pickingIngredient ? [] : searchFriendRecipes(db, user.id, match),
  }
})

/**
 * Matching recipes belonging to friends who share theirs.
 *
 * `COALESCE(g.share_recipes, 1)` because a user who has never opened Settings
 * may predate the column; absent means shared, matching the column default and
 * `sharePermissions()` on the client.
 *
 * Empty recipes are left out — `serving_grams IS NULL` is how a recipe with no
 * ingredients is stored, and there is nothing to copy or log from one.
 */
function searchFriendRecipes(
  db: ReturnType<typeof useDb>,
  userId: number,
  match: string,
) {
  const ids = friendIds(db, userId)
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')

  return db
    .prepare(
      `SELECT f.id, f.name, f.source, f.brand, f.is_liquid, f.kcal,
              f.recipe_servings, f.recipe_final_weight_g, f.serving_grams,
              u.id AS owner_id, u.name AS owner_name, u.email AS owner_email
       FROM foods_fts
       JOIN foods f ON f.id = foods_fts.rowid
       JOIN users u ON u.id = f.owner_user_id
       LEFT JOIN user_goals g ON g.user_id = u.id
       WHERE foods_fts MATCH ?
         AND f.source = ?
         AND f.serving_grams IS NOT NULL
         AND f.owner_user_id IN (${placeholders})
         AND COALESCE(g.share_recipes, 1) = 1
       ORDER BY foods_fts.rank
       LIMIT ?`,
    )
    .all(match, RECIPE_SOURCE, ...ids, FRIEND_RESULT_LIMIT)
}

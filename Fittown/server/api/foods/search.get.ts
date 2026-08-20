import { prioritizeServingSize } from '#shared/foods'
import { RECIPE_LOG_SOURCE, RECIPE_SOURCE } from '#shared/recipes'
import { friendIds, friendSharesCustomFoods } from '../../utils/friends'
import { ancestorIds } from '../../utils/recipes'
import {
  buildFtsQuery,
  foodCols,
  foodColsBare,
  SEARCH_SCAN_LIMIT,
  SEARCH_SCORE,
} from '../../utils/foods'

/** A friend's recipes are a courtesy, not the point of the screen. */
const FRIEND_RESULT_LIMIT = 12

/** The recipe this search is picking an ingredient for, if it is. */
function forRecipeId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
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
  const { q, limit, for_recipe: forRecipe } = getQuery(event)

  const text = typeof q === 'string' ? q.trim() : ''
  if (text.length < 2) return { results: [], friend_results: [] }

  const match = buildFtsQuery(text)
  if (!match) return { results: [], friend_results: [] }

  const want = Math.min(Number(limit) || 30, 60)
  const db = useDb()

  // `for_recipe` means "I am picking an ingredient for this recipe". Recipes
  // are legitimate ingredients now, so what has to come out of the results is
  // narrower than it was: the recipe itself, and anything that already contains
  // it — the two ways a pick would make a recipe that contains itself. Refusing
  // here as well as at save time is the friendlier half of the same rule.
  const recipeId = forRecipeId(forRecipe)
  const pickingIngredient = recipeId !== null
  const forbidden = recipeId === null ? [] : [recipeId, ...ancestorIds(db, recipeId)]

  // Friends who have turned on sharing their custom foods. Their rows join the
  // main results (they are directly loggable, unlike a friend's recipe, which
  // has to be copied first). Interpolated rather than bound: node:sqlite has no
  // array binding, and the ids are integers we derived ourselves.
  const customFriendIds = friendIds(db, user.id).filter((id) =>
    friendSharesCustomFoods(db, user.id, id),
  )
  const friendCustomFilter = customFriendIds.length
    ? ` OR (f.source = 'custom' AND f.owner_user_id IN (${customFriendIds.join(',')}))`
    : ''

  const results = db
    .prepare(
      `WITH scored AS (
         SELECT ${foodCols()}, ${SEARCH_SCORE} AS score
         FROM foods_fts
         JOIN foods f ON f.id = foods_fts.rowid
         WHERE foods_fts MATCH $match
           AND (f.owner_user_id IS NULL OR f.owner_user_id = $userId ${friendCustomFilter})
           AND f.source != $logSource
           ${forbidden.length ? `AND f.id NOT IN (${forbidden.join(',')})` : ''}
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
      // Belt and braces: a frozen meal is never indexed, so it cannot reach
      // this query anyway — but it must never be offered as anything.
      logSource: RECIPE_LOG_SOURCE,
    })

  const rawResults = prioritizeServingSize(results as { serving_grams: unknown }[])

  // Say who made a food owned by someone else, so the list is honest about a
  // friend's row sitting in search. Own foods and OFF rows stay unlabelled —
  // "by you" is noise and nobody owns an OFF product. One query for every
  // distinct owner on the page rather than one per row.
  const otherOwners = [
    ...new Set(
      rawResults
        .map((f) => Number((f as { owner_user_id: number | null }).owner_user_id))
        .filter((id) => Number.isInteger(id) && id > 0 && id !== user.id),
    ),
  ]
  if (otherOwners.length > 0) {
    const owners = db
      .prepare(
        `SELECT id, name, email FROM users
         WHERE id IN (${otherOwners.join(',')})`,
      )
      .all() as { id: number; name: string; email: string }[]
    const byId = new Map(owners.map((o) => [Number(o.id), o]))
    for (const food of rawResults) {
      const ownerId = Number((food as { owner_user_id: number | null }).owner_user_id)
      const owner = byId.get(ownerId)
      if (owner) (food as { owner_name?: string | null }).owner_name = owner.name || owner.email
    }
  }

  return {
    results: rawResults,
    // Nothing to offer when we're picking an ingredient. A friend's recipe is
    // not yours to nest — tapping one offers to copy it, and a copy is what you
    // would have to put in your salad anyway.
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

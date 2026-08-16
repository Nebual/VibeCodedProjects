import { RECIPE_SOURCE } from '#shared/recipes'
import {
  buildFtsQuery,
  foodCols,
  foodColsBare,
  SEARCH_SCAN_LIMIT,
  SEARCH_SCORE,
} from '../../utils/foods'

/**
 * Search the local food database.
 *
 * Custom foods belonging to the caller are always visible; OFF products are
 * shared. Results are de-duplicated by name+brand — OFF holds many
 * near-identical entries per product — keeping the best-scoring one of each.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { q, limit, exclude_recipes: excludeRecipes } = getQuery(event)

  const text = typeof q === 'string' ? q.trim() : ''
  if (text.length < 2) return { results: [] }

  const match = buildFtsQuery(text)
  if (!match) return { results: [] }

  const want = Math.min(Number(limit) || 30, 60)

  const results = useDb()
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
      includeRecipes: excludeRecipes ? 0 : 1,
      recipeSource: RECIPE_SOURCE,
    })

  return { results }
})

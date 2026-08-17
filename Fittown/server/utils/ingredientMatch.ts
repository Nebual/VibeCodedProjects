import type { DatabaseSync } from 'node:sqlite'
import { RECIPE_SOURCE } from '#shared/recipes'
import { buildFtsQuery, SEARCH_SCORE } from './foods.ts'

/**
 * Deciding which food a written ingredient line actually is.
 *
 * The rule this file exists to enforce: **a wrong match is worse than no
 * match.** An unmatched line shows up on screen as a row with no nutrition and
 * a warning above it. A wrong one shows up as a finished-looking recipe whose
 * calorie count is silently off — and nothing in the app would ever say so.
 *
 * So this is not "best search result wins". It is a set of conditions a
 * candidate has to clear, and a null return whenever it doesn't.
 */

/** How many FTS hits to consider before applying the rules below. */
const CANDIDATE_LIMIT = 40

/**
 * Words that carry no meaning for identifying a food.
 *
 * Kept short on purpose. "fresh basil" and "Basil" are the same leaf, but
 * "ground beef" and "beef" are not the same product, so anything that changes
 * what the thing *is* stays in.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'with',
  'fresh', 'organic', 'natural', 'plain', 'pure', 'quality',
])

/**
 * Words whose presence means the candidate is a *different food*, not a more
 * specific name for the same one.
 *
 * This list is the whole reason the matcher is trustworthy. Without it,
 * "avocado oil" matches "Avocado Oil Cooking Spray" — every query term is
 * present, the search ranks it first, and the recipe comes out several hundred
 * calories light while looking perfectly complete.
 *
 * Note `dried`: dried oregano and fresh oregano differ by an order of
 * magnitude per 100 g, so that is a choice for the user to make, not for us.
 */
const FORM_WORDS = new Set([
  'spray', 'powder', 'powdered', 'mix', 'flavored', 'flavoured', 'flavor',
  'flavour', 'infused', 'sauce', 'dressing', 'seasoning', 'marinade', 'paste',
  'drink', 'beverage', 'juice', 'snack', 'bar', 'bars', 'chips', 'crisps',
  'cookie', 'cookies', 'candy', 'syrup', 'concentrate', 'extract',
  'substitute', 'alternative', 'imitation', 'style', 'free', 'light', 'lite',
  'reduced', 'diet', 'zero', 'dried', 'smoked', 'roasted', 'salted',
  'unsalted', 'sweetened', 'unsweetened', 'canned', 'frozen', 'instant',
])

/**
 * How many words a candidate may carry beyond what the user wrote.
 *
 * Scaled to the length of the query, and zero for a one-word one. "Balsamic
 * vinegar" is specific enough that "Balsamic Vinegar of Modena" is obviously
 * the same thing; "salt" is not, and against a 200k-row food library the extra
 * word is as likely to be part of a different product's name — the real hit
 * that prompted this was "salt" matching **Salt & Vinegar**, a crisp flavour,
 * which then reported 0 kcal as though it were a measurement.
 *
 * A single common word therefore has to match exactly or not at all.
 */
function maxExtraWords(queryLength: number): number {
  return queryLength >= 2 ? 2 : 0
}

/**
 * Reduce a name to comparable words.
 *
 * Crude singularisation — drop a trailing `s` from words over three letters —
 * which is wrong for "molasses" and right for almost everything else. It only
 * ever affects whether two names are judged equal, never what gets stored.
 */
export function normalizeFoodName(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => !STOPWORDS.has(word))
}

export type MatchConfidence = 'exact' | 'strong'

export interface IngredientMatch {
  food_id: number
  confidence: MatchConfidence
  /** The matched food's name, for logging and for the import summary. */
  name: string
}

/**
 * Decide whether `candidate` is the food that `queryWords` names.
 *
 * Returns null when it isn't, which is the common and correct outcome.
 */
export function judgeCandidate(
  queryWords: string[],
  candidateName: string,
  hasEnergy: boolean,
): MatchConfidence | null {
  if (queryWords.length === 0) return null

  const candidateWords = normalizeFoodName(candidateName)
  if (candidateWords.length === 0) return null

  const candidateSet = new Set(candidateWords)

  // Every word the user wrote has to appear. "olive oil" must not match "oil".
  if (!queryWords.every((word) => candidateSet.has(word))) return null

  const querySet = new Set(queryWords)
  const extras = candidateWords.filter((word) => !querySet.has(word))

  if (extras.length === 0) return 'exact'

  // Beyond here we are accepting a *more specific* name for the same food —
  // "Balsamic Vinegar of Modena" for "balsamic vinegar" — so the bar is higher.
  if (!hasEnergy) return null
  if (extras.length > maxExtraWords(querySet.size)) return null
  if (extras.some((word) => FORM_WORDS.has(word))) return null

  return 'strong'
}

/**
 * Find the food a parsed ingredient line refers to, or null.
 *
 * Searches the same index the user would have searched by hand, then applies
 * `judgeCandidate` to the results rather than trusting the ranking. Recipes are
 * excluded: one recipe still can't be an ingredient in another.
 */
export function matchIngredient(
  db: DatabaseSync,
  userId: number,
  name: string,
): IngredientMatch | null {
  const queryWords = normalizeFoodName(name)
  if (queryWords.length === 0) return null

  const match = buildFtsQuery(name)
  if (!match) return null

  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.kcal, f.owner_user_id, f.popularity,
              ${SEARCH_SCORE} AS score
       FROM foods_fts
       JOIN foods f ON f.id = foods_fts.rowid
       WHERE foods_fts MATCH $match
         AND (f.owner_user_id IS NULL OR f.owner_user_id = $userId)
         AND f.source != $recipeSource
       ORDER BY score DESC
       LIMIT $limit`,
    )
    .all({
      match,
      userId,
      exact: name,
      recipeSource: RECIPE_SOURCE,
      limit: CANDIDATE_LIMIT,
    }) as {
      id: number
      name: string
      kcal: number | null
      owner_user_id: number | null
      popularity: number
    }[]

  let best: (IngredientMatch & { own: boolean; popularity: number }) | null = null

  for (const row of rows) {
    const confidence = judgeCandidate(queryWords, row.name, row.kcal !== null)
    if (!confidence) continue

    const own = row.owner_user_id !== null
    const candidate = {
      food_id: row.id,
      confidence,
      name: row.name,
      own,
      popularity: row.popularity ?? 0,
    }

    if (!best) {
      best = candidate
      continue
    }

    // Your own foods first — you made them for a reason. Then an exact name
    // over a more specific one, then whatever more people actually buy.
    const better =
      (candidate.own && !best.own)
      || (candidate.own === best.own && candidate.confidence === 'exact' && best.confidence !== 'exact')
      || (candidate.own === best.own && candidate.confidence === best.confidence
        && candidate.popularity > best.popularity)

    if (better) best = candidate
  }

  if (!best) return null
  return { food_id: best.food_id, confidence: best.confidence, name: best.name }
}

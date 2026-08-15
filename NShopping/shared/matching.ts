/**
 * Fuzzy matching for bulk-pasted shopping notes against items already on a list.
 *
 * Real notes are messy — "eggs x2", "the Breton crackers", "black beans totally empty
 * I think" — so matching works on meaningful word tokens rather than whole strings, and
 * tolerates plurals and typos at the token level.
 */

export interface MatchCandidate {
  id: string
  name: string
}

export interface MatchResult {
  id: string
  name: string
  score: number
}

/** Below this a match is a guess, not a match, and the user is asked instead. */
export const MATCH_THRESHOLD = 0.62

/** Words that carry no identity: "the Breton crackers" is just "Breton crackers". */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'some', 'any', 'my', 'our', 'of', 'and', 'more', 'extra', 'another',
  'please', 'need', 'needs', 'get', 'buy', 'grab', 'pick', 'up',
])

/** Bare counts and multipliers: "eggs x2", "2x milk", "3 lemons". */
const QUANTITY_RE = /^(?:x\d+|\d+x|\d+(?:[.,]\d+)?)$/

/**
 * Bullets, dashes and "1." that survive a copy-paste. "+" is in here as well as in the
 * separator below: handwritten lists use it as a bullet constantly, and without it a
 * photographed "+ milk" is added as an item literally called "+ milk".
 */
const LIST_MARKER_RE = /^\s*(?:[-+*•·–—]+|\d+[.)])\s+/

/**
 * A "+" or "-" left standing on its own *between* words runs several items onto one
 * line — "tuna - nutritional yeast + garlic" is three things to buy, not one. This shows
 * up constantly in photographed handwriting, where a bullet for the next item gets
 * transcribed onto the end of the previous line.
 *
 * Whitespace on both sides is the whole guard: it is what keeps "half-and-half",
 * "gluten-free bread" and "7-up" intact, since a hyphen inside a compound word never has
 * it. The cost is that a genuine aside — "milk - the 2% one" — splits in two, which is
 * the deliberate trade: a stray extra line is one tap to delete, whereas a silently
 * swallowed item is not noticed until you are home.
 */
const INLINE_SEPARATOR_RE = /\s+[-+–—]+\s+/

/**
 * The same separator with nothing after it — "tuna -" at the end of a photographed line.
 * Detached by whitespace for the same reason as above, which is what leaves "vitamin B+"
 * alone.
 */
const DANGLING_SEPARATOR_RE = /\s+[-+–—]+\s*$/

/**
 * Something has to be left to shop for. A letter, specifically, not just any character:
 * splitting on a detached dash turns a trailing quantity into its own segment
 * ("apples - 2"), and a bare "2" is a row that can never match anything and can only be
 * deleted. Groceries have names.
 */
const HAS_CONTENT_RE = /\p{L}/u

export function splitBulkInput(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .flatMap(line => line.split(INLINE_SEPARATOR_RE))
    // Both are re-run per segment rather than per line: splitting can expose a marker
    // that was sitting mid-line, and a leading "- " never matches the separator above
    // for want of a space in front of it.
    .map(part => part.replace(LIST_MARKER_RE, '').replace(DANGLING_SEPARATOR_RE, '').trim())
    .filter(part => HAS_CONTENT_RE.test(part))
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Tokens that actually identify the item. Falls back to the raw tokens when stripping
 * would leave nothing — "the" on its own should still be able to match an item called "the".
 */
export function meaningfulTokens(text: string): string[] {
  const tokens = tokenize(text).filter(token => !QUANTITY_RE.test(token))
  const kept = tokens.filter(token => !STOPWORDS.has(token))
  return kept.length ? kept : tokens
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!
  }
  return prev[b.length]!
}

/**
 * Light English plural stripping. Plurals are the overwhelmingly common variation in
 * shopping notes, so folding them explicitly lets the typo budget below stay tight —
 * "pecans"/"pecan" is a plural, "pecans"/"pears" is a different food.
 */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(?:o|s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/**
 * 1 for identical, tapering for near-misses, 0 once the words are too far apart.
 * The typo budget is deliberately mean: at five letters or fewer the stems must match
 * exactly, because at that length almost every "near miss" is a different product.
 */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1

  const stemA = stem(a)
  const stemB = stem(b)
  if (stemA === stemB) return 0.97

  const longest = Math.max(stemA.length, stemB.length)
  const allowed = longest <= 5 ? 0 : longest <= 8 ? 1 : 2
  if (allowed === 0) return 0

  const distance = levenshtein(stemA, stemB)
  return distance > allowed ? 0 : 1 - distance / longest
}

interface Containment {
  /** Average per-token similarity across the run. */
  similarity: number
  /** How many haystack tokens the run spans — 2 for an uninterrupted pair. */
  span: number
  /** Where the run starts in the haystack. */
  start: number
}

/** Finds `needle`'s tokens inside `haystack`, in order, or null if any is missing. */
function contains(needle: string[], haystack: string[]): Containment | null {
  let from = 0
  let total = 0
  let start = -1
  let end = -1

  for (const token of needle) {
    let bestIndex = -1
    let bestScore = 0
    for (let j = from; j < haystack.length; j++) {
      const score = tokenSimilarity(token, haystack[j]!)
      if (score > bestScore) {
        bestScore = score
        bestIndex = j
      }
    }
    if (bestIndex === -1) return null
    total += bestScore
    if (start === -1) start = bestIndex
    end = bestIndex
    from = bestIndex + 1
  }

  return { similarity: total / needle.length, span: end - start + 1, start }
}

/**
 * Scores one note against one item name. Two shapes count as a match:
 * the item's name appearing inside a chatty note ("black beans" in "black beans totally
 * empty I think"), or a shorthand note appearing inside a longer item name
 * ("salmon" for "canned salmon"). The first is the stronger signal.
 */
export function scoreMatch(noteTokens: string[], itemTokens: string[]): number {
  if (!noteTokens.length || !itemTokens.length) return 0

  const forward = contains(itemTokens, noteTokens)
  if (forward) {
    const density = itemTokens.length / noteTokens.length
    const contiguity = itemTokens.length / forward.span
    const leading = forward.start === 0 ? 1 : 0
    return 0.62 * forward.similarity + 0.18 * density + 0.12 * contiguity + 0.08 * leading
  }

  const reverse = contains(noteTokens, itemTokens)
  if (reverse) {
    const density = noteTokens.length / itemTokens.length
    return 0.55 * reverse.similarity + 0.20 * density + 0.10 * (reverse.start === 0 ? 1 : 0)
  }

  return 0
}

/** Best-scoring candidate above the threshold, or null. Ties go to the shorter name. */
export function bestMatch(note: string, candidates: MatchCandidate[]): MatchResult | null {
  const noteTokens = meaningfulTokens(note)
  if (!noteTokens.length) return null

  let best: MatchResult | null = null
  for (const candidate of candidates) {
    const score = scoreMatch(noteTokens, meaningfulTokens(candidate.name))
    if (score < MATCH_THRESHOLD) continue
    if (!best || score > best.score || (score === best.score && candidate.name.length < best.name.length)) {
      best = { id: candidate.id, name: candidate.name, score }
    }
  }
  return best
}

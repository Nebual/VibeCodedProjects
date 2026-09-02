/**
 * Turning a written ingredient line into an amount and a name.
 *
 * This is the spine of both import paths: a pasted list and a scraped recipe
 * both end up here, so `1/4c avocado oil` means one thing in the app rather
 * than two. It is deliberately pure and deliberately dumb — no database, no
 * network, no cleverness it can't be tested on.
 *
 * The governing rule comes from the feature's spec: **a line with no clear
 * numeric amount is worth 0 g**, and the words that stood in for a number are
 * kept as a note for the user to read and act on. Guessing that "a lot of
 * oregano" is 5 g would put a number in a nutrition total that nobody typed.
 *
 * The relative `./portions.ts` import matches the convention in `recipes.ts`:
 * with the extension this module loads unchanged under Vite, Vitest and plain
 * `node`.
 */

import { RECIPE_UNITS, type RecipeUnit } from './portions.ts'
import { VULGAR } from './mathExpr.ts'

export interface ParsedIngredientLine {
  /** The line exactly as it arrived, before any of this happened. */
  raw: string
  /** What's left to search the food database for, e.g. "balsamic vinegar". */
  name: string
  /**
   * Base units — grams, or millilitres for a volume. **0 when the line states
   * no numeric amount**, which is not a measurement of zero but an absence of
   * one; `note` says what stood in its place.
   */
  grams: number
  /** "cup", "tbsp" — null when the amount was already a plain weight. */
  serving_label: string | null
  serving_count: number | null
  /** The part that wasn't an amount or a name: "a lot of", "minced", "1 to 2". */
  note: string | null
}

const VULGAR_CLASS = `[${Object.keys(VULGAR).join('')}]`

/**
 * One quantity. Ordered longest-match-first, which is load-bearing: `1 1/2`
 * has to win over `1`, and `1½` over `1`, or every mixed number loses its
 * fraction and the recipe silently halves.
 */
const NUMBER = [
  `\\d+\\s*${VULGAR_CLASS}`, // 1½
  '\\d+\\s+\\d+\\s*/\\s*\\d+', // 1 1/2
  '\\d+\\s*/\\s*\\d+', // 1/2
  VULGAR_CLASS, // ½
  '\\d+(?:[.,]\\d+)?', // 2, 2.5, 2,5
  '\\.\\d+', // .5
].join('|')

/** Words that mean "an amount I'm not going to measure". */
const DESCRIPTORS = [
  'pinch', 'pinches', 'dash', 'dashes', 'handful', 'handfuls', 'sprinkle',
  'splash', 'drizzle', 'smidge', 'smidgen', 'touch', 'lot', 'lots', 'few',
  'couple', 'some', 'several', 'plenty', 'bunch',
]

const DESCRIPTOR_RE = new RegExp(
  `^(?:a\\s+|an\\s+)?(?:${DESCRIPTORS.join('|')})\\b(?:\\s+of)?\\s+`,
  'i',
)

/**
 * Preparation and qualifier phrases. Moved to the note rather than dropped:
 * "divided" and "plus more for serving" change how much you actually use, and
 * the user is the one who gets to decide what that means.
 *
 * Longest first, so "finely chopped" doesn't leave a stray "finely" behind.
 */
const PREP = [
  'plus more for serving', 'plus more for drizzling', 'plus more to taste',
  'plus more', 'at room temperature', 'room temperature', 'lightly packed',
  'firmly packed', 'freshly ground', 'freshly squeezed', 'finely chopped',
  'roughly chopped', 'coarsely chopped', 'thinly sliced', 'cut into chunks',
  'cut into cubes', 'to taste', 'or to taste', 'if needed', 'as needed',
  'optional', 'divided', 'packed', 'chopped', 'minced', 'diced', 'sliced',
  'grated', 'shredded', 'crushed', 'melted', 'softened', 'drained', 'rinsed',
  'peeled', 'seeded', 'stemmed', 'halved', 'quartered', 'cubed', 'julienned',
  'zested', 'beaten', 'whisked', 'toasted', 'crumbled', 'trimmed', 'thawed',
]

const PREP_RE = new RegExp(`\\b(?:${PREP.join('|')})\\b`, 'gi')

/** Bullets, checkboxes and numbering that survive a copy-paste. */
const FURNITURE_RE = /^[\s\-–—*•·▪▫◦‣⁃□☐▢✓✔]+/

/** Aliases longest-first, so "tablespoons" is never read as "tb". */
const ALIASES: { alias: string; unit: RecipeUnit }[] = RECIPE_UNITS
  .flatMap((unit) => unit.aliases.map((alias) => ({ alias, unit })))
  .sort((a, b) => b.alias.length - a.alias.length)

/** Read one quantity, including fractions and mixed numbers. */
function parseNumber(text: string): number {
  const trimmed = text.trim()

  // "1½" and "1 ½"
  const mixedVulgar = trimmed.match(new RegExp(`^(\\d+)\\s*(${VULGAR_CLASS})$`))
  if (mixedVulgar) return Number(mixedVulgar[1]) + VULGAR[mixedVulgar[2]!]!

  if (trimmed.length === 1 && VULGAR[trimmed] !== undefined) return VULGAR[trimmed]!

  // "1 1/2"
  const mixed = trimmed.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/)
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])

  // "1/2"
  const fraction = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (fraction) return Number(fraction[1]) / Number(fraction[2])

  // A decimal comma is European notation, not a thousands separator: nobody
  // writes "1,500 g of flour" in a recipe, and "1,5" is common enough.
  return Number(trimmed.replace(',', '.'))
}

/**
 * Match a unit at the start of `text`.
 *
 * The alias must not be followed by another letter, which is the whole reason
 * `1 clove garlic` doesn't parse as one cup: `c` matches, `l` follows, reject,
 * and no longer alias fits either.
 */
function matchUnit(text: string): { unit: RecipeUnit; length: number } | null {
  // A bare T/t is ambiguous everywhere except in recipes, where the convention
  // is old and consistent. Checked before the case-insensitive pass, which
  // would otherwise resolve both to whichever is listed first.
  const bare = text.match(/^([Tt])\.?(?![A-Za-z])/)
  if (bare) {
    const key = bare[1] === 'T' ? 'tbsp' : 'tsp'
    return { unit: RECIPE_UNITS.find((u) => u.key === key)!, length: bare[0].length }
  }

  const lower = text.toLowerCase()
  for (const { alias, unit } of ALIASES) {
    if (!lower.startsWith(alias)) continue
    // Allow a trailing period ("2 Tbsp.") but nothing alphabetic.
    let length = alias.length
    if (text[length] === '.') length += 1
    if (/[a-z]/i.test(text[length] ?? '')) continue
    return { unit, length }
  }
  return null
}

/** Tidy what's left after the amount and the notes have been taken out. */
function cleanName(text: string): string {
  return text
    .replace(/[\s,;:.]+$/, '')
    .replace(/^[\s,;:.]+/, '')
    .replace(/^(?:of|or|and)\s+/i, '')
    .replace(/\s+(?:of|or|and)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Parse one line.
 *
 * Returns `null` for anything that isn't an ingredient — a blank line, or a
 * section heading like "For the dressing:" — so a paste that includes them
 * doesn't produce empty rows.
 */
export function parseIngredientLine(line: string): ParsedIngredientLine | null {
  const raw = line.trim()
  if (raw === '') return null

  let rest = raw.replace(FURNITURE_RE, '')
  // "1." / "2)" numbering, but not "1.5" or "1/4" — the punctuation must be
  // followed by a space, which a decimal point never is.
  rest = rest.replace(/^\d+\s*[.)]\s+/, '')
  rest = rest.trim()

  if (rest === '') return null
  // A heading, not an ingredient. Digits rule out "2 cups flour:" oddities.
  if (/:$/.test(rest) && !/\d/.test(rest)) return null

  const notes: string[] = []

  // Parentheticals first, from anywhere in the line: "(room temp)", "(optional)".
  rest = rest.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    const text = inner.trim()
    if (text) notes.push(text)
    return ' '
  })

  let grams = 0
  let servingLabel: string | null = null
  let servingCount: number | null = null

  // A range: take the lower bound, and keep the whole thing as a note. Lower
  // rather than the midpoint because an undercount the user can see and raise
  // beats a number nobody wrote down.
  const rangeRe = new RegExp(`^(${NUMBER})\\s*(?:-|–|—|to|or)\\s*(${NUMBER})\\s*`, 'i')
  const range = rest.match(rangeRe)

  const amountRe = new RegExp(`^(${NUMBER})\\s*`)
  const amount = range ?? rest.match(amountRe)

  if (amount) {
    const count = parseNumber(amount[1]!)
    let after = rest.slice(amount[0].length)
    const unit = matchUnit(after)

    if (unit) {
      after = after.slice(unit.length)
      grams = count * unit.unit.size
      // A plain weight needs no label — "45 g" reads as itself, and the diary's
      // convention is that a base-unit portion carries no "n × label".
      if (unit.unit.size !== 1) {
        servingLabel = unit.unit.label
        servingCount = count
      }
      if (range) notes.push(`${amount[0].trim()}${unit.unit.label}`.replace(/\s+/g, ' '))
    } else {
      // A number with no unit is a count of something — "2 large eggs",
      // "1 garlic clove". We have no per-egg weight, so it is worth 0 g and the
      // count is kept for the user to turn into an amount.
      notes.push(amount[0].trim())
    }

    rest = after
  }

  // Anything after the first comma is describing, not naming.
  const comma = rest.indexOf(',')
  if (comma !== -1) {
    const tail = rest.slice(comma + 1).trim()
    if (tail) notes.push(tail)
    rest = rest.slice(0, comma)
  }

  // A leading "pinch of" / "a lot of" — only meaningful when no amount was
  // found, but harmless to strip either way.
  const descriptor = rest.match(DESCRIPTOR_RE)
  if (descriptor) {
    notes.push(descriptor[0].trim())
    rest = rest.slice(descriptor[0].length)
  }

  // Prep words, from the name and from the notes we've already collected.
  rest = rest.replace(PREP_RE, (match) => {
    notes.push(match.toLowerCase())
    return ' '
  })

  const name = cleanName(rest)
  // Everything was an amount and a note. Fall back to the line itself rather
  // than storing a nameless row: the user needs to see what they pasted.
  const finalName = name || cleanName(raw) || raw

  // De-duplicated: "chopped (chopped)" happens, and so does a prep word that
  // appears in both the parenthetical and the tail.
  const note = [...new Set(notes.map((n) => n.trim()).filter(Boolean))].join(', ')

  return {
    raw,
    name: finalName,
    grams,
    serving_label: servingLabel,
    serving_count: servingCount,
    note: note || null,
  }
}

/**
 * Parse a pasted block, one ingredient per line.
 *
 * Blank lines and section headings drop out. Nothing here caps the count —
 * that belongs to the route, which has to reject an over-long paste before it
 * writes any of it.
 */
export function parseIngredientList(text: string): ParsedIngredientLine[] {
  return text
    .split(/\r?\n/)
    .map(parseIngredientLine)
    .filter((line): line is ParsedIngredientLine => line !== null)
}

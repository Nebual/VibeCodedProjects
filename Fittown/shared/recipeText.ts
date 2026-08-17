/**
 * Recipe prose: splitting a paste into sections, and assembling the
 * instructions block an import writes.
 *
 * Pure, like `ingredientText.ts`, and for the same reason — it is all string
 * handling with a lot of edge cases and no reason to need a database to test.
 */

/** Headings that introduce the ingredient list. */
const INGREDIENTS_HEADING = /^\s*ingredients?\s*:?\s*$/i

/** Headings that introduce the method. */
const INSTRUCTIONS_HEADING =
  /^\s*(?:instructions?|directions?|method|steps|preparation|how\s+to\s+make\s+it)\s*:?\s*$/i

export interface PastedSections {
  /** Raw ingredient lines, still unparsed. */
  ingredients: string
  /** Everything under a method heading, or null if the paste had none. */
  instructions: string | null
}

/**
 * Split a pasted block into ingredients and instructions.
 *
 * Without a method heading the whole paste is ingredients — which is the
 * common case, and the one the feature was asked for. With one, the split
 * stops "Whisk together the oil and vinegar" being parsed as an ingredient and
 * stored as a 0 g mystery row.
 */
export function splitPastedSections(text: string): PastedSections {
  const lines = text.split(/\r?\n/)

  const methodAt = lines.findIndex((line) => INSTRUCTIONS_HEADING.test(line))
  if (methodAt === -1) {
    // An "Ingredients" heading on its own still wants removing.
    return {
      ingredients: lines.filter((line) => !INGREDIENTS_HEADING.test(line)).join('\n'),
      instructions: null,
    }
  }

  const before = lines.slice(0, methodAt).filter((line) => !INGREDIENTS_HEADING.test(line))
  const after = lines.slice(methodAt + 1)

  const instructions = after.join('\n').trim()

  return {
    ingredients: before.join('\n'),
    instructions: instructions === '' ? null : instructions,
  }
}

export interface ImportedInstructionsInput {
  steps: string[]
  /** Already humanised — "5 mins", "1 hr 15 mins". */
  prepTime?: string | null
  cookTime?: string | null
  totalTime?: string | null
  /** As written: "6 to 8", "4 servings". */
  yieldText?: string | null
  sourceUrl?: string | null
}

/**
 * Assemble the instructions text for an imported recipe.
 *
 * Plain text, not markdown: this lands in a textarea the user edits by hand,
 * and half-rendered markup in an edit box is worse than none. The facts go at
 * the top where they're read before cooking, the steps in the middle, and the
 * source at the bottom — which is both the attribution and the way back to the
 * original when the import got something wrong.
 */
export function formatImportedInstructions(input: ImportedInstructionsInput): string {
  const blocks: string[] = []

  const facts: string[] = []
  if (input.prepTime) facts.push(`Prep Time: ${input.prepTime}`)
  if (input.cookTime) facts.push(`Cook Time: ${input.cookTime}`)
  if (input.totalTime) facts.push(`Total Time: ${input.totalTime}`)
  if (input.yieldText) facts.push(`Serves ${input.yieldText}`)
  if (facts.length) blocks.push(facts.join('\n'))

  const steps = input.steps.map((step) => step.trim()).filter(Boolean)
  if (steps.length) {
    // Numbered here rather than trusting the source: scraped steps arrive
    // numbered, half-numbered, or as bare sentences, and one consistent list
    // beats faithfully reproducing three different conventions.
    blocks.push(steps.map((step, i) => `${i + 1}. ${step}`).join('\n\n'))
  }

  if (input.sourceUrl) blocks.push(`Source: ${input.sourceUrl}`)

  return blocks.join('\n\n')
}

/**
 * Pull a serving count out of a written yield.
 *
 * "6 to 8" gives 6 — the lower end, matching how the ingredient parser treats
 * an amount range, so a recipe that says "serves 6 to 8" never reports a
 * per-serving figure smaller than a serving actually is.
 *
 * Returns null for anything without a leading number ("1 loaf"), which leaves
 * the recipe at one serving for the user to correct.
 */
export function servingsFromYield(text: string | null | undefined): number | null {
  if (!text) return null
  const match = String(text).match(/\d+(?:\.\d+)?/)
  if (!match) return null
  const value = Number(match[0])
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null
  return value
}

import { parseIngredientList } from '#shared/ingredientText'
import { splitPastedSections } from '#shared/recipeText'
import { MAX_INGREDIENTS, MAX_INSTRUCTIONS_CHARS } from '#shared/recipes'
import { fallbackRecipeName, importRecipe } from '../../../utils/recipeImport'

/**
 * Build a recipe from a pasted list of ingredients.
 *
 * The user types or pastes what they'd write on a shopping list; we parse it,
 * attach a food to every line we're confident about, and leave the rest as text
 * for them to resolve. Nothing here guesses at an amount — see
 * `shared/ingredientText.ts` for why.
 */

/** Enough for any real recipe; a guard against a pasted novel. */
const MAX_PASTE_CHARS = 20000

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const text = assertText(body.text, 'text', MAX_PASTE_CHARS)
  const sections = splitPastedSections(text)
  const lines = parseIngredientList(sections.ingredients)

  if (lines.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Nothing in that looked like an ingredient',
    })
  }

  // Checked before anything is written, not discovered forty rows in.
  if (lines.length > MAX_INGREDIENTS) {
    throw createError({
      statusCode: 400,
      statusMessage: `That's ${lines.length} ingredients; a recipe can hold ${MAX_INGREDIENTS}`,
    })
  }

  const requestedName = optionalText(body.name, 200)
  const servings = optionalNumber(body.servings, 'servings', { min: 0.1, max: 100 })

  // An explicit instructions field wins over one found in the paste: if the
  // user filled the box in, they meant it.
  const instructions =
    optionalText(body.instructions, MAX_INSTRUCTIONS_CHARS)
    ?? (sections.instructions
      ? sections.instructions.slice(0, MAX_INSTRUCTIONS_CHARS)
      : null)

  const result = transact((db) =>
    importRecipe(db, user.id, {
      name: requestedName ?? fallbackRecipeName(db, user.id),
      lines,
      instructions,
      servings,
    }),
  )

  setResponseStatus(event, 201)
  return result
})

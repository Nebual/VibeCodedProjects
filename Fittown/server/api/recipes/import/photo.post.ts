import { parseIngredientList } from '#shared/ingredientText'
import { MAX_INGREDIENTS, MAX_INSTRUCTIONS_CHARS } from '#shared/recipes'
import { fallbackRecipeName, importRecipe } from '../../../utils/recipeImport'
import { RecipeOcrError, transcribeRecipeImage } from '../../../utils/recipeOcr'

/**
 * Build a recipe from a photo — a cookbook page, a printed recipe card, a
 * handwritten note.
 *
 * The photo goes to a locally-run vision model (`utils/recipeOcr.ts`); from
 * there it's the same `importRecipe` path a pasted list or a scraped URL goes
 * through, so a scanned recipe behaves exactly like one typed in by hand.
 */

/** A client-resized JPEG easily fits under this; guards against a raw phone photo. */
const MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const { baseUrl, model } = useRuntimeConfig().recipeOcr
  if (!baseUrl) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Photo scanning isn’t set up on this server',
    })
  }

  // Checked by hand rather than with `assertText`: that helper truncates
  // oversized input with `.slice`, which would hand a corrupt half-image to
  // the model instead of rejecting it outright.
  if (typeof body.image !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(body.image)) {
    throw createError({ statusCode: 400, statusMessage: 'image must be a JPEG, PNG or WebP data URL' })
  }
  if (body.image.length > MAX_IMAGE_DATA_URL_CHARS) {
    throw createError({ statusCode: 400, statusMessage: 'That photo is too large' })
  }

  let ocr
  try {
    ocr = await transcribeRecipeImage(body.image, baseUrl, model)
  } catch (err) {
    if (err instanceof RecipeOcrError) {
      throw createError({ statusCode: 422, statusMessage: err.message })
    }
    throw err
  }

  const lines = parseIngredientList(ocr.ingredients)
  if (lines.length === 0) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Couldn’t find any ingredients in that photo',
    })
  }
  if (lines.length > MAX_INGREDIENTS) {
    throw createError({
      statusCode: 400,
      statusMessage: `That's ${lines.length} ingredients; a recipe can hold ${MAX_INGREDIENTS}`,
    })
  }

  const requestedName = optionalText(body.name, 200)
  const servings = optionalNumber(body.servings, 'servings', { min: 0.1, max: 100 }) ?? ocr.servings
  const instructions = ocr.instructions?.slice(0, MAX_INSTRUCTIONS_CHARS) ?? null

  const result = transact((db) =>
    importRecipe(db, user.id, {
      name: requestedName ?? ocr.name?.slice(0, 200) ?? fallbackRecipeName(db, user.id),
      lines,
      instructions,
      servings,
    }),
  )

  setResponseStatus(event, 201)
  return { ...result, name: requestedName ?? ocr.name }
})

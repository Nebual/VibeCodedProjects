import { parseIngredientList } from '#shared/ingredientText'
import { formatImportedInstructions, servingsFromYield } from '#shared/recipeText'
import { draftFromHtml } from '#shared/recipeScrape'
import { MAX_INGREDIENTS, MAX_INSTRUCTIONS_CHARS } from '#shared/recipes'
import { fetchPageHtml, PageFetchError } from '../../../utils/fetchPage'
import { fallbackRecipeName, importRecipe } from '../../../utils/recipeImport'

/**
 * Build a recipe from a URL.
 *
 * Everything specific to the web lives upstream of `importRecipe` — fetching,
 * scraping, and turning times and yield into prose. From there it is the same
 * code path as a pasted list, so a recipe imported from a URL behaves exactly
 * like one typed in by hand.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const input = assertText(body.url, 'url', 2000)

  let page: { html: string; url: string }
  try {
    page = await fetchPageHtml(input)
  } catch (err) {
    // These messages are written for the user, so they go out as-is. Anything
    // else is a bug and should not be reflected back.
    if (err instanceof PageFetchError) {
      throw createError({ statusCode: 400, statusMessage: err.message })
    }
    throw err
  }

  const draft = draftFromHtml(page.html)
  if (!draft || draft.ingredientLines.length === 0) {
    throw createError({
      statusCode: 422,
      statusMessage:
        'Couldn’t find a recipe on that page. Try copying the ingredients and pasting them instead.',
    })
  }

  const lines = parseIngredientList(draft.ingredientLines.join('\n'))
  if (lines.length === 0) {
    throw createError({
      statusCode: 422,
      statusMessage: 'That page’s ingredient list came out empty',
    })
  }
  if (lines.length > MAX_INGREDIENTS) {
    throw createError({
      statusCode: 400,
      statusMessage: `That recipe has ${lines.length} ingredients; a recipe can hold ${MAX_INGREDIENTS}`,
    })
  }

  const instructions = formatImportedInstructions({
    steps: draft.steps,
    prepTime: draft.prepTime,
    cookTime: draft.cookTime,
    totalTime: draft.totalTime,
    yieldText: draft.yieldText,
    // The URL the page was actually served from, after redirects — that is the
    // one worth keeping, and it is what the user goes back to when the import
    // got something wrong.
    sourceUrl: page.url,
  }).slice(0, MAX_INSTRUCTIONS_CHARS)

  const result = transact((db) =>
    importRecipe(db, user.id, {
      name: draft.name?.slice(0, 200) || fallbackRecipeName(db, user.id),
      lines,
      instructions,
      servings: servingsFromYield(draft.yieldText),
    }),
  )

  setResponseStatus(event, 201)
  return { ...result, source: draft.source }
})

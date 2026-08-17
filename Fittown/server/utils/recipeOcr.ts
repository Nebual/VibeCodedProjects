/**
 * Recipe photo → text, via a local vision model.
 *
 * The model runs in llama-server (an OpenAI-compatible chat completions
 * endpoint) on the household's own network rather than a hosted API — same
 * reasoning as importing Open Food Facts and USDA locally: no third party
 * sees a photo of what's for dinner, and no per-request cost. Everything
 * downstream of the fields returned here is the same `importRecipe` path a
 * pasted list or a scraped URL goes through.
 */

/** Vision inference on a local box is slow; a food blog page fetch is not. */
const TIMEOUT_MS = 120000

export class RecipeOcrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecipeOcrError'
  }
}

export interface RecipeOcrResult {
  name: string | null
  /** Ingredient lines joined with '\n' — the shape `parseIngredientList` expects. */
  ingredients: string
  instructions: string | null
  servings: number | null
}

const SYSTEM_PROMPT = `You transcribe recipes from photos of cookbook pages, printed recipe cards, or handwritten notes.
Read the image and reply with ONLY a JSON object, no other text, matching exactly this shape:
{"name": string or null, "ingredients": string[], "instructions": string or null, "servings": number or null}

- "name": the recipe's title, or null if none is visible.
- "ingredients": one array entry per ingredient line, transcribed as written (e.g. "2 cups flour", "1/2 tsp salt") — do not merge lines or invent amounts that aren't in the photo.
- "instructions": the method, as plain text with steps in order, or null if none is visible.
- "servings": the number of servings the recipe states, or null.

If the image doesn't contain a recipe, reply {"name": null, "ingredients": [], "instructions": null, "servings": null}.`

/**
 * Pull the JSON object out of a chat completion reply and validate its shape.
 *
 * Split out from `transcribeRecipeImage` so the parsing — the part with edge
 * cases worth naming in a test — can be tested without a model to talk to.
 * Models asked for "only JSON" still sometimes wrap it in a code fence or add
 * a sentence before it, so this takes the substring between the first `{` and
 * the last `}` rather than requiring the whole reply to be clean JSON.
 */
export function parseOcrResponse(raw: string): RecipeOcrResult {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new RecipeOcrError('The scanner didn’t return anything readable')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new RecipeOcrError('The scanner’s reply wasn’t valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new RecipeOcrError('The scanner’s reply wasn’t shaped like a recipe')
  }
  const obj = parsed as Record<string, unknown>

  const ingredientsArray = Array.isArray(obj.ingredients)
    ? obj.ingredients.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
    : []

  if (ingredientsArray.length === 0) {
    throw new RecipeOcrError('Couldn’t find any ingredients in that photo')
  }

  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : null
  const instructions =
    typeof obj.instructions === 'string' && obj.instructions.trim() ? obj.instructions.trim() : null
  const servings =
    typeof obj.servings === 'number' && Number.isFinite(obj.servings) && obj.servings > 0
      ? obj.servings
      : null

  return { name, ingredients: ingredientsArray.join('\n'), instructions, servings }
}

/**
 * Send an image to the configured vision model and parse its reply.
 *
 * `baseUrl` and `model` come from `useRuntimeConfig().recipeOcr` rather than
 * being hardcoded here — the dev machine and the production box run
 * llama-server at different addresses (see .env.example).
 */
export async function transcribeRecipeImage(
  imageDataUrl: string,
  baseUrl: string,
  model: string,
): Promise<RecipeOcrResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(new URL('/v1/chat/completions', baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Transcribe this recipe.' },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new RecipeOcrError(
      aborted ? 'The recipe scanner took too long to answer' : 'Couldn’t reach the recipe scanner',
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new RecipeOcrError(`The recipe scanner returned an error (${response.status})`)
  }

  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const content = body.choices?.[0]?.message?.content
  if (!content) {
    throw new RecipeOcrError('The recipe scanner didn’t return anything')
  }

  return parseOcrResponse(content)
}

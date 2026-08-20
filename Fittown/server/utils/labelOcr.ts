/**
 * Nutrition Facts label photo → structured nutrients, via the same local
 * vision model the recipe scanner uses (`recipeOcr.ts`).
 *
 * A food label is a different shape from a recipe, so it gets its own prompt
 * and its own parser — but it talks to the same llama-server endpoint and the
 * same configured model (runtimeConfig.recipeOcr), so a box that can scan a
 * recipe can scan a label too, and the "scan a photo" feature is enabled or
 * hidden for both at once.
 *
 * The vision model is asked for the *label's* structure (serving size + a list
 * of named nutrient amounts, e.g. {"name":"Calories","value":210}). The
 * mapping from those human names ("Saturated", "Fibre") to the app's canonical
 * nutrient keys lives in code here, not in the prompt — a model quoting "Fat /
 * Lipides" shouldn't be the thing that decides which column that lands in.
 */

/** The label mentions a serving ("Per 3 bars (45 g)"). */
export interface LabelServing {
  /** The label's own wording, e.g. "3 bars (45 g)". */
  label: string | null
  /** Gram weight of that serving, if the label stated one. */
  grams: number | null
}

export interface LabelOcrResult {
  serving: LabelServing
  /** Canonical nutrient key → amount for the serving, e.g. { fiber_g: 3 }. */
  nutrients: Record<string, number>
}

export class LabelOcrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LabelOcrError'
  }
}

/**
 * Normalised label name → canonical nutrient key (see `shared/nutrients.ts`).
 *
 * Keys are the name lower-cased with every non-alphanumeric character removed,
 * so "Saturated Fat", "Saturated / gras saturés" and "Saturated" all reach
 * `sat_fat_g`. The map holds both whole phrases and the bare word where labels
 * vary ("Saturated" vs "Saturated Fat", "Carbohydrate" vs "Carbohydrates").
 */
const LABEL_KEY: Record<string, string> = {
  calories: 'kcal',
  energy: 'kcal',
  fat: 'fat_g',
  saturated: 'sat_fat_g',
  saturates: 'sat_fat_g',
  saturatedfat: 'sat_fat_g',
  trans: 'trans_fat_g',
  transfat: 'trans_fat_g',
  monounsaturated: 'mono_fat_g',
  polyunsaturated: 'poly_fat_g',
  cholesterol: 'cholesterol_mg',
  sodium: 'sodium_mg',
  potassium: 'potassium_mg',
  carbohydrate: 'carbs_g',
  carbohydrates: 'carbs_g',
  fibre: 'fiber_g',
  fiber: 'fiber_g',
  sugars: 'sugars_g',
  addedsugars: 'added_sugars_g',
  sugaralcohols: 'sugar_alcohols_g',
  protein: 'protein_g',
  calcium: 'calcium_mg',
  iron: 'iron_mg',
  magnesium: 'magnesium_mg',
  zinc: 'zinc_mg',
  phosphorus: 'phosphorus_mg',
  copper: 'copper_mg',
  manganese: 'manganese_mg',
  selenium: 'selenium_ug',
  iodine: 'iodine_ug',
  vitamina: 'vit_a_ug',
  vitaminc: 'vit_c_mg',
  vitamind: 'vit_d_ug',
  vitamine: 'vit_e_mg',
  vitamink: 'vit_k_ug',
  thiamin: 'vit_b1_mg',
  riboflavin: 'vit_b2_mg',
  niacin: 'vit_b3_mg',
  vitaminb6: 'vit_b6_mg',
  folate: 'folate_ug',
  vitaminb12: 'vit_b12_mg',
  caffeine: 'caffeine_mg',
  alcohol: 'alcohol_g',
  water: 'water_g',
}

/**
 * Turn one label line name into the app's nutrient key, or null if it isn't
 * a nutrient we store (or is a % Daily Value row).
 *
 * "Disregard the French" happens here and in the prompt: the English value
 * sits before the '/' in a bilingual Canadian label ("Fat / Lipides"), so the
 * name is split on '/' and only the English side is matched. Leading
 * "of which" (UK-style "of which Saturates") is stripped too.
 */
export function labelNameToKey(name: string): string | null {
  const english = name.split('/')[0].trim()
  let normalized = english.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized.startsWith('ofwhich')) normalized = normalized.slice('ofwhich'.length)
  return LABEL_KEY[normalized] ?? null
}

/** A plain string like "45 g" → its number, or null if there isn't one. */
function parseGrams(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:g|gram|grams|grammes|ml|millilitre|millilitres)\b/i)
  if (!m) return null
  const value = Number(m[1])
  return Number.isFinite(value) && value >= 0.1 ? value : null
}

const NULL_BYTE = String.fromCharCode(0)

/**
 * Pull the label JSON out of a chat completion reply and normalise it.
 *
 * Split out from `transcribeLabelImage` so the mapping — the part with edge
 * cases worth naming in a test — can be tested without a model to talk to.
 * Accepts `nutrients` as either an object or an array (models vary), and
 * drops anything it can't map to a stored nutrient, so a stray "% Daily
 * Value" or an unreadable line simply doesn't prefill a field.
 */
export function parseLabelOcrResponse(raw: string): LabelOcrResult {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new LabelOcrError('The scanner didn’t return anything readable')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new LabelOcrError('The scanner’s reply wasn’t valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new LabelOcrError('The scanner’s reply wasn’t shaped like a label')
  }
  const obj = parsed as Record<string, unknown>

  const nutrients: Record<string, number> = {}

  const push = (name: string, value: unknown): void => {
    // A nutrient with no useful value is not a nutrient we can store.
    if (typeof value !== 'number' && typeof value !== 'string') return
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num) || num < 0 || num > 1_000_000) return
    const key = labelNameToKey(name)
    if (key) nutrients[key] = num
  }

  const list = obj.nutrients
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      // Some models nest value under `value`, some under `amount`; both OK.
      const value = e.value ?? e.amount
      if (typeof e.name === 'string') push(e.name, value)
    }
  } else if (typeof list === 'object' && list !== null) {
    for (const [name, value] of Object.entries(list as Record<string, unknown>)) {
      if (name === NULL_BYTE) continue
      push(name, value)
    }
  }

  // The serving size, with a fallback to parsing grams out of the label text.
  let servingLabel: string | null = null
  let servingGrams: number | null = null
  if (typeof obj.serving_label === 'string' && obj.serving_label.trim()) {
    servingLabel = obj.serving_label.trim()
  }
  const stated = typeof obj.serving_grams === 'number' ? obj.serving_grams : null
  servingGrams =
    stated !== null && Number.isFinite(stated) && stated >= 0.1 ? stated : null
  if (servingGrams === null && servingLabel) {
    servingGrams = parseGrams(servingLabel.replace(/per\s+/i, ''))
  }

  return { serving: { label: servingLabel, grams: servingGrams }, nutrients }
}

const SYSTEM_PROMPT = `You read Nutrition Facts labels from photos (a food package label, the white "Nutrition Facts" panel).
Read the image and reply with ONLY a JSON object, no other text, matching exactly this shape:
{"serving_label": string or null, "serving_grams": number or null, "nutrients": [{"name": string, "value": number}]}

- "serving_label": the label's serving description, verbatim (e.g. "3 bars (45 g)", "Per 1 cup (250 mL)"), or null if none.
- "serving_grams": the gram weight of that serving if the label states one (e.g. 45), else null.
- "nutrients": one entry for every nutrient amount shown on the label, as the AMOUNT PER SERVING only. "name" is the nutrient name exactly as printed on the English side, "value" is its number with the unit NOT included.

Rules:
- Ignore the "% Daily Value" numbers entirely; report only the per-serving amounts.
- On bilingual Canadian labels ("Fat / Lipides", "Sugars / Sucres"), use only the English name before the slash.
- Do not invent nutrients that are not on the label. Do not estimate.
- Keep the number as printed (0 stays 0).`

/**
 * Send a label image to the configured vision model and parse its reply.
 *
 * `baseUrl` and `model` come from `useRuntimeConfig().recipeOcr` — the same
 * config the recipe scanner uses — so this needs no configuration of its own.
 */
export async function transcribeLabelImage(
  imageDataUrl: string,
  baseUrl: string,
  model: string,
): Promise<LabelOcrResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)

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
              { type: 'text', text: 'Transcribe this Nutrition Facts label.' },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new LabelOcrError(
      aborted ? 'The label scanner took too long to answer' : 'Couldn’t reach the label scanner',
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new LabelOcrError(`The label scanner returned an error (${response.status})`)
  }

  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const content = body.choices?.[0]?.message?.content
  if (!content) {
    throw new LabelOcrError('The label scanner didn’t return anything')
  }

  return parseLabelOcrResponse(content)
}

/**
 * Reading a recipe out of a web page.
 *
 * Three strategies, tried in order, because recipe sites are not consistent:
 *
 * 1. **JSON-LD** — `schema.org/Recipe` in a `<script type="application/ld+json">`.
 *    This is what WP Recipe Maker, Tasty Recipes and most modern food blogs
 *    emit, because Google's rich results require it. When it's there it is
 *    exact, and there is nothing to guess.
 * 2. **Microdata** — the older `itemprop` markup, still on plenty of sites.
 * 3. **Headings** — find an "Ingredients" heading and read the list under it.
 *    A genuine guess, and the only option on a plain hand-written page.
 *
 * All three are pure string-in / struct-out so they can be tested against saved
 * fixtures with no network — which is also what keeps `pnpm test` runnable
 * offline in half a second.
 *
 * Deliberately no HTML parser dependency. The shapes involved are shallow, the
 * app has no DOM on the server, and adding a parser to read four fields is a
 * supply-chain decision this project doesn't need to make.
 */

export interface RecipeDraft {
  name: string | null
  /** Ingredient lines, still unparsed — `ingredientText.ts` handles those. */
  ingredientLines: string[]
  steps: string[]
  /** Humanised: "5 mins", "1 hr 15 mins". */
  prepTime: string | null
  cookTime: string | null
  totalTime: string | null
  /** As written: "6 to 8". */
  yieldText: string | null
  /** Which strategy produced this, for the response and for debugging. */
  source: 'jsonld' | 'microdata' | 'headings'
}

/** Named entities common in scraped text, plus numeric escapes. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', deg: '°',
  frac12: '½', frac13: '⅓', frac23: '⅔', frac14: '¼', frac34: '¾',
  frac18: '⅛', frac38: '⅜', frac58: '⅝', frac78: '⅞',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
}

/** Strip tags and collapse whitespace — scraped strings routinely carry both. */
export function stripHtml(text: string): string {
  return decodeEntities(
    text
      // Block-level ends become spaces so "a</p><p>b" doesn't become "ab".
      .replace(/<\/(?:p|div|li|br|h[1-6])>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Humanise an ISO-8601 duration.
 *
 * Only the parts a recipe uses. `PT1H15M` → "1 hr 15 mins", `PT5M` → "5 mins".
 * Anything unparseable comes back as null rather than as its raw ISO string,
 * which would read as a typo in the instructions block.
 */
export function humanizeDuration(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i)
  if (!match) return null

  const [, d, h, m] = match
  const parts: string[] = []
  if (d) parts.push(`${d} ${Number(d) === 1 ? 'day' : 'days'}`)
  if (h) parts.push(`${h} ${Number(h) === 1 ? 'hr' : 'hrs'}`)
  if (m) parts.push(`${m} ${Number(m) === 1 ? 'min' : 'mins'}`)

  return parts.length ? parts.join(' ') : null
}

/** Does this node's `@type` name a Recipe? It may be a string or an array. */
function isRecipeNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const type = (node as Record<string, unknown>)['@type']
  const types = Array.isArray(type) ? type : [type]
  return types.some((t) => typeof t === 'string' && t.toLowerCase() === 'recipe')
}

/**
 * Find the Recipe node anywhere in a parsed JSON-LD document.
 *
 * It arrives as a bare object, an array of objects, or wrapped in `@graph` —
 * Love and Lemons uses `@graph`, alongside Article, WebPage, BreadcrumbList and
 * four others. Walking all three shapes is cheaper than guessing which.
 */
function findRecipeNode(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || !node || typeof node !== 'object') return null

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item, depth + 1)
      if (found) return found
    }
    return null
  }

  if (isRecipeNode(node)) return node as Record<string, unknown>

  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
    const found = findRecipeNode((node as Record<string, unknown>)[key], depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Match `name="value"`, `name='value'` or bare `name=value`.
 *
 * The unquoted form is not an edge case: HTML minifiers strip quotes as a
 * matter of course, and Love and Lemons serves
 * `<script type=application/ld+json class=yoast-schema-graph>`. A pattern that
 * insists on quotes finds no structured data there and silently falls through
 * to the heading scrape, which produces a recipe made of navigation links.
 */
function attr(name: string, value: string): string {
  return `${name}\\s*=\\s*(?:["']${value}["']|${value}(?=[\\s>]))`
}

/** Every `<script type="application/ld+json">` payload on the page. */
function jsonLdBlocks(html: string): string[] {
  const blocks: string[] = []
  const re = new RegExp(
    `<script[^>]*${attr('type', 'application\\/ld\\+json')}[^>]*>([\\s\\S]*?)</script>`,
    'gi',
  )
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) blocks.push(match[1]!)
  return blocks
}

/**
 * Flatten `recipeInstructions`, which has four shapes in the wild: a single
 * string with newlines, an array of strings, an array of `HowToStep`, and an
 * array of `HowToSection` each holding its own `itemListElement`.
 */
function flattenInstructions(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return []

  if (typeof value === 'string') {
    // Turn the markup breaks into newlines *before* stripping, or `stripHtml`
    // collapses every separator into a space and the whole method arrives as
    // one paragraph. A single-string `recipeInstructions` full of <p> tags is
    // as common as one with real newlines in it.
    return value
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .split(/\n+/)
      .map(stripHtml)
      .filter(Boolean)
  }

  if (Array.isArray(value)) return value.flatMap((item) => flattenInstructions(item, depth + 1))

  if (typeof value === 'object') {
    const node = value as Record<string, unknown>
    // A section holds steps; a step holds text. Sections first, or a section's
    // own `name` ("For the dressing") would be emitted as if it were a step.
    if (node.itemListElement) return flattenInstructions(node.itemListElement, depth + 1)
    const text = node.text ?? node.name
    return typeof text === 'string' && text.trim() ? [stripHtml(text)] : []
  }

  return []
}

/**
 * The yield, as text.
 *
 * `recipeYield` is a number, a string, or an array of both — Love and Lemons
 * sends `["6", "6 to 8"]`. The longest string is the descriptive one, which is
 * what belongs in the instructions block; the serving *count* is extracted
 * separately by `servingsFromYield`.
 */
function yieldText(value: unknown): string | null {
  const candidates = (Array.isArray(value) ? value : [value])
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => stripHtml(String(v)))
    .filter(Boolean)

  if (candidates.length === 0) return null
  return candidates.reduce((longest, next) => (next.length > longest.length ? next : longest))
}

/** Strategy 1: structured data. */
export function draftFromJsonLd(html: string): RecipeDraft | null {
  for (const block of jsonLdBlocks(html)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      // A malformed block on a page is common and is not a reason to give up —
      // there may be a good one after it.
      continue
    }

    const recipe = findRecipeNode(parsed)
    if (!recipe) continue

    const ingredients = (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : [])
      .filter((line): line is string => typeof line === 'string')
      .map(stripHtml)
      .filter(Boolean)

    const steps = flattenInstructions(recipe.recipeInstructions)
    if (ingredients.length === 0 && steps.length === 0) continue

    return {
      name: typeof recipe.name === 'string' ? stripHtml(recipe.name) : null,
      ingredientLines: ingredients,
      steps,
      prepTime: humanizeDuration(recipe.prepTime),
      cookTime: humanizeDuration(recipe.cookTime),
      totalTime: humanizeDuration(recipe.totalTime),
      yieldText: yieldText(recipe.recipeYield),
      source: 'jsonld',
    }
  }
  return null
}

/** Every value of a given `itemprop`, in document order. */
function microdataValues(html: string, prop: string): string[] {
  const values: string[] = []
  const re = new RegExp(
    `<([a-z0-9]+)[^>]*${attr('itemprop', prop)}[^>]*>([\\s\\S]*?)</\\1>`,
    'gi',
  )
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const text = stripHtml(match[2]!)
    if (text) values.push(text)
  }
  // Times and yields are often on a <meta content="..."> instead.
  const metaRe = new RegExp(`<meta[^>]*${attr('itemprop', prop)}[^>]*>`, 'gi')
  let meta: RegExpExecArray | null
  while ((meta = metaRe.exec(html)) !== null) {
    const content = meta[0].match(/content=["']([^"']*)["']/i)
    if (content?.[1]) values.push(decodeEntities(content[1]))
  }
  return values
}

/** Strategy 2: the older microdata markup. */
export function draftFromMicrodata(html: string): RecipeDraft | null {
  if (!new RegExp(attr('itemtype', '[^"\'\\s>]*schema\\.org\\/Recipe'), 'i').test(html)) return null

  const ingredients = [
    ...microdataValues(html, 'recipeIngredient'),
    ...microdataValues(html, 'ingredients'),
  ]
  const steps = [
    ...microdataValues(html, 'recipeInstructions'),
    ...microdataValues(html, 'instructions'),
  ]
  if (ingredients.length === 0 && steps.length === 0) return null

  return {
    name: microdataValues(html, 'name')[0] ?? null,
    ingredientLines: ingredients,
    steps,
    prepTime: humanizeDuration(microdataValues(html, 'prepTime')[0]),
    cookTime: humanizeDuration(microdataValues(html, 'cookTime')[0]),
    totalTime: humanizeDuration(microdataValues(html, 'totalTime')[0]),
    yieldText: microdataValues(html, 'recipeYield')[0] ?? null,
    source: 'microdata',
  }
}

const INGREDIENTS_HEADING = /ingredients?/i
const INSTRUCTIONS_HEADING = /instructions?|directions|method|steps/i

/**
 * Strategy 3: read the lists under the headings.
 *
 * The honest last resort. It looks for a heading whose text names a section and
 * takes the list items that follow, stopping at the next heading. On a page
 * that lays a recipe out any other way this returns nothing, which is the right
 * answer — the route then tells the user to paste it instead of inventing rows.
 */
export function draftFromHeadings(html: string): RecipeDraft | null {
  const sections: { heading: string; body: string }[] = []
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi

  let match: RegExpExecArray | null
  let previous: { heading: string; start: number } | null = null

  while ((match = re.exec(html)) !== null) {
    if (previous) {
      sections.push({ heading: previous.heading, body: html.slice(previous.start, match.index) })
    }
    previous = { heading: stripHtml(match[2]!), start: re.lastIndex }
  }
  if (previous) sections.push({ heading: previous.heading, body: html.slice(previous.start) })

  const listItems = (body: string) => {
    const items: string[] = []
    const li = /<li[^>]*>([\s\S]*?)<\/li>/gi
    let item: RegExpExecArray | null
    while ((item = li.exec(body)) !== null) {
      const text = stripHtml(item[1]!)
      if (text) items.push(text)
    }
    return items
  }

  const ingredientSection = sections.find((s) => INGREDIENTS_HEADING.test(s.heading))
  const instructionSection = sections.find((s) => INSTRUCTIONS_HEADING.test(s.heading))

  const ingredients = ingredientSection ? listItems(ingredientSection.body) : []
  const steps = instructionSection ? listItems(instructionSection.body) : []

  if (ingredients.length === 0) return null

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)

  return {
    name: title ? stripHtml(title[1]!) : null,
    ingredientLines: ingredients,
    steps,
    prepTime: null,
    cookTime: null,
    totalTime: null,
    yieldText: null,
    source: 'headings',
  }
}

/** All three strategies, best first. Null when the page yields nothing. */
export function draftFromHtml(html: string): RecipeDraft | null {
  return draftFromJsonLd(html) ?? draftFromMicrodata(html) ?? draftFromHeadings(html)
}

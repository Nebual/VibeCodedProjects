import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  draftFromHeadings,
  draftFromHtml,
  draftFromJsonLd,
  draftFromMicrodata,
  humanizeDuration,
  stripHtml,
} from '#shared/recipeScrape'
import { formatImportedInstructions, servingsFromYield, splitPastedSections } from '#shared/recipeText'
import { parseIngredientList } from '#shared/ingredientText'

/**
 * Reading a recipe out of a page.
 *
 * The Love and Lemons fixture is the real page's real JSON-LD, saved rather
 * than written by hand, so these tests describe what that site actually emits —
 * including the awkward bits, like `recipeYield` being `["6", "6 to 8"]`.
 * Fixtures rather than network calls, so the suite still runs offline.
 */

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

describe('the Love and Lemons balsamic vinaigrette', () => {
  const html = fixture('loveandlemons-balsamic-vinaigrette.html')

  it('is read from JSON-LD', () => {
    const draft = draftFromJsonLd(html)!
    expect(draft.source).toBe('jsonld')
    expect(draft.name).toBe('Balsamic Vinaigrette')
  })

  it('reads the script tag even though the site strips its quotes', () => {
    // The page really is served as `<script type=application/ld+json ...>`.
    // Requiring quotes finds nothing, falls through to the heading scrape, and
    // imports six rows of navigation links — which is what it did first time.
    expect(html).toContain('type=application/ld+json')
    expect(draftFromHtml(html)!.source).toBe('jsonld')
  })

  it('finds the Recipe node inside @graph', () => {
    // The page's JSON-LD is one @graph holding Article, WebPage, WebSite,
    // BreadcrumbList, Organization and the Recipe. Taking the first node would
    // find an Article and import nothing.
    const draft = draftFromJsonLd(html)!
    expect(draft.ingredientLines).toHaveLength(7)
  })

  it('reads the ingredients as written', () => {
    const draft = draftFromJsonLd(html)!
    expect(draft.ingredientLines[0]).toBe('¼ cup balsamic vinegar')
    expect(draft.ingredientLines).toContain('6 tablespoons extra-virgin olive oil')
  })

  it('flattens HowToStep instructions to their text', () => {
    const draft = draftFromJsonLd(html)!
    expect(draft.steps.length).toBeGreaterThanOrEqual(2)
    expect(draft.steps[0]).toContain('whisk together the vinegar')
    // The @type and url fields must not leak into the prose.
    expect(draft.steps.join(' ')).not.toContain('HowToStep')
    expect(draft.steps.join(' ')).not.toContain('wprm-recipe')
  })

  it('humanises the ISO durations', () => {
    const draft = draftFromJsonLd(html)!
    expect(draft.prepTime).toBe('5 mins')
    expect(draft.totalTime).toBe('5 mins')
    expect(draft.cookTime).toBeNull()
  })

  it('takes the descriptive half of the yield', () => {
    // recipeYield is ["6", "6 to 8"]. "6" alone loses what the site said.
    const draft = draftFromJsonLd(html)!
    expect(draft.yieldText).toBe('6 to 8')
    // And the serving count is the lower end, so a serving is never overstated.
    expect(servingsFromYield(draft.yieldText)).toBe(6)
  })

  it('parses end to end into ingredients with real amounts', () => {
    const draft = draftFromHtml(html)!
    const lines = parseIngredientList(draft.ingredientLines.join('\n'))

    expect(lines).toHaveLength(7)
    expect(lines[0]).toMatchObject({
      name: 'balsamic vinegar',
      serving_label: 'cup',
      serving_count: 0.25,
    })
    // 6 US tablespoons of olive oil.
    const oil = lines.find((l) => l.name.includes('olive oil'))!
    expect(oil.grams).toBeCloseTo(88.72, 1)

    // "1  garlic clove (grated)" is a count, not a weight — 0 g with a note.
    const garlic = lines.find((l) => l.name.includes('garlic'))!
    expect(garlic.grams).toBe(0)
    expect(garlic.note).toContain('grated')

    // "Freshly ground black pepper" has no amount at all.
    const pepper = lines.find((l) => l.name.includes('pepper'))!
    expect(pepper.grams).toBe(0)
  })

  it('builds an instructions block with the times, yield and source', () => {
    const draft = draftFromHtml(html)!
    const text = formatImportedInstructions({
      steps: draft.steps,
      prepTime: draft.prepTime,
      cookTime: draft.cookTime,
      totalTime: draft.totalTime,
      yieldText: draft.yieldText,
      sourceUrl: 'https://www.loveandlemons.com/balsamic-vinaigrette/',
    })

    expect(text).toContain('Prep Time: 5 mins')
    expect(text).toContain('Total Time: 5 mins')
    expect(text).toContain('Serves 6 to 8')
    expect(text).toContain('1. In a small bowl')
    expect(text.trimEnd().endsWith('Source: https://www.loveandlemons.com/balsamic-vinaigrette/'))
      .toBe(true)
  })
})

describe('JSON-LD shapes that turn up in the wild', () => {
  const wrap = (json: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head><body></body></html>`

  it('reads a bare Recipe object', () => {
    const draft = draftFromJsonLd(
      wrap({ '@type': 'Recipe', name: 'X', recipeIngredient: ['1 cup flour'] }),
    )!
    expect(draft.ingredientLines).toEqual(['1 cup flour'])
  })

  it('reads a Recipe in a top-level array', () => {
    const draft = draftFromJsonLd(
      wrap([{ '@type': 'WebPage' }, { '@type': 'Recipe', recipeIngredient: ['1 cup flour'] }]),
    )!
    expect(draft.ingredientLines).toEqual(['1 cup flour'])
  })

  it('reads a Recipe whose @type is an array', () => {
    const draft = draftFromJsonLd(
      wrap({ '@type': ['Recipe', 'NewsArticle'], recipeIngredient: ['1 cup flour'] }),
    )!
    expect(draft.ingredientLines).toEqual(['1 cup flour'])
  })

  it('flattens HowToSection instructions', () => {
    const draft = draftFromJsonLd(
      wrap({
        '@type': 'Recipe',
        recipeIngredient: ['1 cup flour'],
        recipeInstructions: [
          {
            '@type': 'HowToSection',
            name: 'For the dressing',
            itemListElement: [
              { '@type': 'HowToStep', text: 'Whisk it.' },
              { '@type': 'HowToStep', text: 'Taste it.' },
            ],
          },
        ],
      }),
    )!
    // The section's own name is not a step.
    expect(draft.steps).toEqual(['Whisk it.', 'Taste it.'])
  })

  it('splits a single instructions string on its newlines', () => {
    const draft = draftFromJsonLd(
      wrap({ '@type': 'Recipe', recipeIngredient: ['x'], recipeInstructions: 'Do this.\nThen this.' }),
    )!
    expect(draft.steps).toEqual(['Do this.', 'Then this.'])
  })

  it('strips markup and decodes entities inside step text', () => {
    const draft = draftFromJsonLd(
      wrap({
        '@type': 'Recipe',
        recipeIngredient: ['x'],
        recipeInstructions: ['<p>Salt &amp; pepper</p>'],
      })!,
    )!
    expect(draft.steps).toEqual(['Salt & pepper'])
  })

  it('skips a malformed block and keeps looking', () => {
    const html =
      '<script type="application/ld+json">{ not json </script>'
      + `<script type="application/ld+json">${JSON.stringify({ '@type': 'Recipe', recipeIngredient: ['1 cup flour'] })}</script>`
    expect(draftFromJsonLd(html)!.ingredientLines).toEqual(['1 cup flour'])
  })

  it('returns null when there is no Recipe at all', () => {
    expect(draftFromJsonLd(wrap({ '@type': 'Article', headline: 'Not a recipe' }))).toBeNull()
    expect(draftFromJsonLd('<html><body>nothing</body></html>')).toBeNull()
  })
})

describe('the fallbacks', () => {
  it('reads microdata with unquoted attributes too', () => {
    const html = `
      <div itemscope itemtype=http://schema.org/Recipe>
        <li itemprop=recipeIngredient>2 cups stock</li>
      </div>`
    expect(draftFromMicrodata(html)!.ingredientLines).toEqual(['2 cups stock'])
  })

  it('reads microdata', () => {
    const html = `
      <div itemscope itemtype="http://schema.org/Recipe">
        <h1 itemprop="name">Old School Soup</h1>
        <meta itemprop="prepTime" content="PT15M">
        <span itemprop="recipeYield">4 servings</span>
        <li itemprop="recipeIngredient">2 cups stock</li>
        <li itemprop="recipeIngredient">1 tsp salt</li>
        <div itemprop="recipeInstructions">Heat it.</div>
      </div>`
    const draft = draftFromMicrodata(html)!
    expect(draft.source).toBe('microdata')
    expect(draft.name).toBe('Old School Soup')
    expect(draft.ingredientLines).toEqual(['2 cups stock', '1 tsp salt'])
    expect(draft.prepTime).toBe('15 mins')
    expect(draft.yieldText).toBe('4 servings')
  })

  it('reads lists under headings when there is no structured data', () => {
    const html = `
      <html><head><title>Nan's Scones</title></head><body>
        <h2>Ingredients</h2>
        <ul><li>500g flour</li><li>2 tsp baking powder</li></ul>
        <h2>Method</h2>
        <ol><li>Mix.</li><li>Bake.</li></ol>
      </body></html>`
    const draft = draftFromHeadings(html)!
    expect(draft.source).toBe('headings')
    expect(draft.name).toBe("Nan's Scones")
    expect(draft.ingredientLines).toEqual(['500g flour', '2 tsp baking powder'])
    expect(draft.steps).toEqual(['Mix.', 'Bake.'])
  })

  it('gives up rather than inventing rows', () => {
    expect(draftFromHeadings('<html><body><p>Just a blog post.</p></body></html>')).toBeNull()
    expect(draftFromHtml('<html><body><p>Just a blog post.</p></body></html>')).toBeNull()
  })

  it('prefers JSON-LD over the heading scrape when both are present', () => {
    const html = `
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Recipe', recipeIngredient: ['from jsonld'] })}</script>
      <h2>Ingredients</h2><ul><li>from headings</li></ul>`
    expect(draftFromHtml(html)!.ingredientLines).toEqual(['from jsonld'])
  })
})

describe('small pure helpers', () => {
  it('humanises durations', () => {
    expect(humanizeDuration('PT5M')).toBe('5 mins')
    expect(humanizeDuration('PT1M')).toBe('1 min')
    expect(humanizeDuration('PT1H15M')).toBe('1 hr 15 mins')
    expect(humanizeDuration('PT2H')).toBe('2 hrs')
    expect(humanizeDuration('P1DT2H')).toBe('1 day 2 hrs')
  })

  it('returns null for a duration it cannot read', () => {
    // Better nothing than "PT5M" printed into the user's instructions.
    expect(humanizeDuration('5 minutes')).toBeNull()
    expect(humanizeDuration(undefined)).toBeNull()
    expect(humanizeDuration('PT')).toBeNull()
  })

  it('decodes entities and collapses whitespace', () => {
    expect(stripHtml('<p>a &amp;  b</p>')).toBe('a & b')
    expect(stripHtml('&frac12; cup')).toBe('½ cup')
    expect(stripHtml('a<br>b')).toBe('a b')
  })

  it('reads a serving count from a written yield', () => {
    expect(servingsFromYield('6 to 8')).toBe(6)
    expect(servingsFromYield('4 servings')).toBe(4)
    expect(servingsFromYield('1 loaf')).toBe(1)
    expect(servingsFromYield('a dozen cookies')).toBeNull()
    expect(servingsFromYield(null)).toBeNull()
  })
})

describe('splitting a paste', () => {
  it('treats the whole paste as ingredients when there is no heading', () => {
    const sections = splitPastedSections('1/4c oil\n45g vinegar')
    expect(sections.instructions).toBeNull()
    expect(parseIngredientList(sections.ingredients)).toHaveLength(2)
  })

  it('splits on a method heading', () => {
    const sections = splitPastedSections(
      'Ingredients\n1/4c oil\n45g vinegar\n\nInstructions\nWhisk them together.\nServe.',
    )
    expect(parseIngredientList(sections.ingredients).map((l) => l.name))
      .toEqual(['oil', 'vinegar'])
    expect(sections.instructions).toBe('Whisk them together.\nServe.')
  })

  it('drops a lone Ingredients heading', () => {
    const sections = splitPastedSections('Ingredients:\n45g vinegar')
    expect(parseIngredientList(sections.ingredients)).toHaveLength(1)
  })
})

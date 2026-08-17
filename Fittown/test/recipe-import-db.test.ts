import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseIngredientList } from '#shared/ingredientText'

/**
 * Ingredient matching and recipe import, against a real SQLite file.
 *
 * The load-bearing test in here is the one that asserts "avocado oil" does
 * *not* match "Avocado Oil Cooking Spray". A matcher that takes the best search
 * hit passes every other test in this file and produces recipes whose calorie
 * counts are quietly wrong.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-import-test-'))
  dbPath = join(dir, 'test.db')
  process.env.FITTOWN_DB_PATH = dbPath
  vi.resetModules()
})

afterEach(() => {
  delete process.env.FITTOWN_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

async function boot() {
  vi.resetModules()
  const { useDb } = await import('../server/utils/db')
  return useDb()
}

const matcher = () => import('../server/utils/ingredientMatch')
const importer = () => import('../server/utils/recipeImport')
const recipes = () => import('../server/utils/recipes')

/** Insert a food and index it, the way every real creation path must. */
function addFood(
  db: DatabaseSync,
  name: string,
  opts: { kcal?: number | null; owner?: number | null; popularity?: number; liquid?: boolean } = {},
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO foods (source, owner_user_id, name, kcal, protein_g, fat_g, popularity, is_liquid)
         VALUES (?, ?, ?, ?, 1, 2, ?, ?)`,
      )
      .run(
        opts.owner ? 'custom' : 'off',
        opts.owner ?? null,
        name,
        opts.kcal === undefined ? 100 : opts.kcal,
        opts.popularity ?? 0,
        opts.liquid ? 1 : 0,
      ).lastInsertRowid,
  )
  db.prepare('INSERT INTO foods_fts(rowid, name, brand) VALUES (?, ?, NULL)').run(id, name)
  return id
}

function seedUser(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')").run()
}

describe('judging a candidate', () => {
  it('accepts an exact name', async () => {
    const { judgeCandidate, normalizeFoodName } = await matcher()
    expect(judgeCandidate(normalizeFoodName('balsamic vinegar'), 'Balsamic Vinegar', true))
      .toBe('exact')
  })

  it('accepts a more specific name for the same food', async () => {
    const { judgeCandidate, normalizeFoodName } = await matcher()
    expect(
      judgeCandidate(normalizeFoodName('balsamic vinegar'), 'Balsamic Vinegar of Modena', true),
    ).toBe('strong')
  })

  it('rejects a candidate that is a different form of the food', async () => {
    const { judgeCandidate, normalizeFoodName } = await matcher()
    const query = normalizeFoodName('avocado oil')
    expect(judgeCandidate(query, 'Avocado Oil Cooking Spray', true)).toBeNull()
    expect(judgeCandidate(query, 'Avocado Oil Flavored Dressing', true)).toBeNull()
  })

  it('will not stretch a one-word name onto a longer one', async () => {
    // Found against the real 203k-food library: "pinch of salt" matched
    // "Salt & Vinegar" — a crisp flavour — and reported 0 kcal as though that
    // were a measurement of the salt. One common word has to match exactly.
    const { judgeCandidate, normalizeFoodName } = await matcher()
    const salt = normalizeFoodName('salt')
    expect(judgeCandidate(salt, 'Salt & Vinegar', true)).toBeNull()
    expect(judgeCandidate(salt, 'Salt and Pepper Chips', true)).toBeNull()
    expect(judgeCandidate(salt, 'Salt', true)).toBe('exact')
    expect(judgeCandidate(salt, 'Sea Salt', true)).toBeNull()

    // Two words is specific enough to accept a longer, more precise name.
    expect(judgeCandidate(normalizeFoodName('balsamic vinegar'), 'Balsamic Vinegar of Modena', true))
      .toBe('strong')
  })

  it('rejects dried for fresh, which differ by an order of magnitude', async () => {
    const { judgeCandidate, normalizeFoodName } = await matcher()
    expect(judgeCandidate(normalizeFoodName('oregano'), 'Dried Oregano', true)).toBeNull()
  })

  it('rejects a candidate missing one of the words the user wrote', async () => {
    const { judgeCandidate, normalizeFoodName } = await matcher()
    expect(judgeCandidate(normalizeFoodName('olive oil'), 'Oil', true)).toBeNull()
  })

  it('rejects a name buried in marketing', async () => {
    const { judgeCandidate, normalizeFoodName } = await matcher()
    expect(
      judgeCandidate(normalizeFoodName('olive oil'), 'Premium Cold Pressed Extra Virgin Olive Oil', true),
    ).toBeNull()
  })

  it('ignores words that do not change what the food is', async () => {
    const { judgeCandidate, normalizeFoodName } = await matcher()
    expect(judgeCandidate(normalizeFoodName('fresh basil'), 'Basil', true)).toBe('exact')
    expect(judgeCandidate(normalizeFoodName('eggs'), 'Egg', true)).toBe('exact')
  })

  it('will not take a more specific name from a food with no energy figure', async () => {
    const { judgeCandidate, normalizeFoodName } = await matcher()
    expect(judgeCandidate(normalizeFoodName('balsamic vinegar'), 'Balsamic Vinegar of Modena', false))
      .toBeNull()
  })
})

describe('matching against the food database', () => {
  it('finds an exact match', async () => {
    const db = await boot()
    seedUser(db)
    const id = addFood(db, 'Balsamic vinegar')
    addFood(db, 'Red wine vinegar')

    const { matchIngredient } = await matcher()
    expect(matchIngredient(db, 1, 'balsamic vinegar')?.food_id).toBe(id)
  })

  it('returns null rather than the best guess', async () => {
    const db = await boot()
    seedUser(db)
    addFood(db, 'Avocado Oil Cooking Spray')
    addFood(db, 'Avocado Oil Blend Dressing')

    const { matchIngredient } = await matcher()
    // Both would come back from the search, ranked. Neither is avocado oil.
    expect(matchIngredient(db, 1, 'avocado oil')).toBeNull()
  })

  it("prefers the user's own food over a shared one", async () => {
    const db = await boot()
    seedUser(db)
    addFood(db, 'Olive oil', { popularity: 9999 })
    const mine = addFood(db, 'Olive oil', { owner: 1 })

    const { matchIngredient } = await matcher()
    expect(matchIngredient(db, 1, 'olive oil')?.food_id).toBe(mine)
  })

  it('prefers an exact name over a more specific one', async () => {
    const db = await boot()
    seedUser(db)
    addFood(db, 'Balsamic vinegar of Modena', { popularity: 9999 })
    const plain = addFood(db, 'Balsamic vinegar')

    const { matchIngredient } = await matcher()
    expect(matchIngredient(db, 1, 'balsamic vinegar')?.food_id).toBe(plain)
  })

  it("never matches another user's private food", async () => {
    const db = await boot()
    seedUser(db)
    db.prepare("INSERT INTO users (id, email, name) VALUES (2, 'other@test', 'Other')").run()
    addFood(db, 'Balsamic vinegar', { owner: 2 })

    const { matchIngredient } = await matcher()
    expect(matchIngredient(db, 1, 'balsamic vinegar')).toBeNull()
  })

  it('never matches a recipe', async () => {
    const db = await boot()
    seedUser(db)
    const { createRecipeFood } = await recipes()
    createRecipeFood(db, 1, 'Balsamic vinegar', 1)

    const { matchIngredient } = await matcher()
    expect(matchIngredient(db, 1, 'balsamic vinegar')).toBeNull()
  })
})

describe('importing a pasted list', () => {
  const PASTE = [
    '1/4c avocado oil',
    '45g balsamic vinegar',
    'pinch of salt',
    'a lot of oregano',
    'garlic powder',
  ].join('\n')

  async function importPaste(db: DatabaseSync) {
    const { importRecipe } = await importer()
    return importRecipe(db, 1, {
      name: 'Balsamic vinaigrette',
      lines: parseIngredientList(PASTE),
    })
  }

  it('creates a recipe with every line, matched or not', async () => {
    const db = await boot()
    seedUser(db)
    addFood(db, 'Balsamic vinegar', { kcal: 88 })
    addFood(db, 'Salt', { kcal: 0 })

    const result = await importPaste(db)
    expect(result.ingredient_count).toBe(5)
    // avocado oil, oregano and garlic powder are not in this tiny database.
    expect(result.unresolved_count).toBe(3)

    const { recipeDetail } = await recipes()
    const detail = recipeDetail(db, result.id, 1)!
    expect(detail.ingredients).toHaveLength(5)
    expect(detail.unresolved_count).toBe(3)
  })

  it('keeps the descriptor as a note the user can act on', async () => {
    const db = await boot()
    seedUser(db)
    addFood(db, 'Salt', { kcal: 0 })

    const result = await importPaste(db)
    const { recipeDetail } = await recipes()
    const detail = recipeDetail(db, result.id, 1)!

    const salt = detail.ingredients.find((i) => i.raw_text === 'pinch of salt')!
    expect(salt.grams).toBe(0)
    expect(salt.note).toBe('pinch of')
    // It matched a food, so it has a name — it just has no amount.
    expect(salt.food).not.toBeNull()

    const oregano = detail.ingredients.find((i) => i.raw_text === 'a lot of oregano')!
    expect(oregano.food).toBeNull()
    expect(oregano.note).toBe('a lot of')
    expect(oregano.nutrients).toEqual({})
  })

  it('does not let a 0 g ingredient blank the recipe’s nutrition', async () => {
    // A 0 g pinch of salt is not weight, and must not be counted as an
    // ingredient that declares no nutrients — or it would zero out a total
    // that should be the vinegar's alone.
    const db = await boot()
    seedUser(db)
    addFood(db, 'Balsamic vinegar', { kcal: 88 })
    addFood(db, 'Salt', { kcal: 0 })

    const result = await importPaste(db)
    const { recipeDetail } = await recipes()
    const detail = recipeDetail(db, result.id, 1)!

    // 45 g of vinegar at 88 kcal/100 g, and nothing else with any weight.
    expect(detail.raw_g).toBeCloseTo(45, 5)
    expect(detail.totals.kcal).toBeCloseTo(39.6, 3)
  })

  it('orders the ingredients the way they were written', async () => {
    const db = await boot()
    seedUser(db)
    const result = await importPaste(db)
    const { recipeDetail } = await recipes()
    const detail = recipeDetail(db, result.id, 1)!
    expect(detail.ingredients.map((i) => i.raw_text)).toEqual(PASTE.split('\n'))
  })

  it('stores the instructions', async () => {
    const db = await boot()
    seedUser(db)
    const { importRecipe } = await importer()
    const result = importRecipe(db, 1, {
      name: 'Vinaigrette',
      lines: parseIngredientList('45g balsamic vinegar'),
      instructions: 'Total Time: 5 mins\n\n1. Whisk.\n\nSource: https://example.com/x',
    })

    const { recipeDetail } = await recipes()
    const detail = recipeDetail(db, result.id, 1)!
    expect(detail.recipe.recipe_instructions).toContain('Whisk')
    expect(detail.recipe.recipe_instructions).toContain('Source: https://example.com/x')
  })

  it('numbers a fallback name against the ones already taken', async () => {
    const db = await boot()
    seedUser(db)
    const { fallbackRecipeName, importRecipe } = await importer()

    expect(fallbackRecipeName(db, 1)).toBe('Imported recipe')
    importRecipe(db, 1, {
      name: fallbackRecipeName(db, 1),
      lines: parseIngredientList('45g sugar'),
    })
    expect(fallbackRecipeName(db, 1)).toBe('Imported recipe 2')
  })
})

describe('copying an imported recipe', () => {
  it('carries unresolved lines, notes and instructions across', async () => {
    const db = await boot()
    seedUser(db)
    db.prepare("INSERT INTO users (id, email, name) VALUES (2, 'friend@test', 'Friend')").run()
    addFood(db, 'Balsamic vinegar', { kcal: 88 })

    const { importRecipe } = await importer()
    const source = importRecipe(db, 1, {
      name: 'Vinaigrette',
      lines: parseIngredientList('45g balsamic vinegar\na lot of oregano'),
      instructions: '1. Whisk.\n\nSource: https://example.com/x',
    })

    const { copyRecipeInto, recipeDetail } = await recipes()
    const copyId = copyRecipeInto(db, source.id, 2)
    const copy = recipeDetail(db, copyId, 2)!

    // A copy that dropped the unmatched line would be a vinaigrette with no
    // oregano, and nothing on screen would say it had gone.
    expect(copy.ingredients).toHaveLength(2)
    expect(copy.unresolved_count).toBe(1)
    const oregano = copy.ingredients.find((i) => i.food === null)!
    expect(oregano.raw_text).toBe('a lot of oregano')
    expect(oregano.note).toBe('a lot of')
    expect(copy.recipe.recipe_instructions).toContain('Whisk')
  })
})

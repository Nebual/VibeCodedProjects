import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SERVING_LABEL, WHOLE_RECIPE_LABEL } from '#shared/recipes'

/**
 * Optional ingredients and one-off adjustments, against a real SQLite file.
 *
 * The rule under all of it: a change made for one meal reaches the frozen copy
 * the diary entry points at, and never the recipe. If that ever slipped, editing
 * tonight's dinner would quietly rewrite the recipe — and every meal logged from
 * it afterwards.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-adjust-test-'))
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

const recipes = () => import('../server/utils/recipes')

function seed(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')").run()
  const insert = db.prepare(
    "INSERT INTO foods (source, name, kcal, protein_g, carbs_g, fat_g, iron_mg) VALUES ('off', ?, ?, ?, ?, ?, ?)",
  )
  return {
    egg: Number(insert.run('Egg', 143, 12.6, 0.7, 9.5, 1.8).lastInsertRowid),
    cheddar: Number(insert.run('Cheddar', 403, 25, 1.3, 33, 0.7).lastInsertRowid),
    bacon: Number(insert.run('Bacon', 541, 37, 1.4, 42, 1.4).lastInsertRowid),
    butter: Number(insert.run('Butter', 717, 0.9, 0.1, 81, 0.02).lastInsertRowid),
  }
}

/**
 * The omelette from the brief: 4 eggs, 35 g cheddar, and 50 g of bacon on top
 * as an optional nobody has switched on.
 */
async function omelette(db: DatabaseSync) {
  const { createRecipeFood, recomputeRecipeAndDependents } = await recipes()
  const ids = seed(db)
  const recipe = createRecipeFood(db, 1, 'Omelette', 1)

  const line = db.prepare(
    `INSERT INTO recipe_ingredients
       (recipe_food_id, food_id, grams, serving_label, serving_count, sort_order,
        is_optional, is_included)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const eggs = Number(line.run(recipe, ids.egg, 200, 'egg', 4, 0, 0, 1).lastInsertRowid)
  const cheese = Number(line.run(recipe, ids.cheddar, 35, null, null, 1, 0, 1).lastInsertRowid)
  const bacon = Number(line.run(recipe, ids.bacon, 50, null, null, 2, 1, 0).lastInsertRowid)

  recomputeRecipeAndDependents(db, recipe)
  return { ...ids, recipe, eggs, cheese, bacon }
}

const row = (db: DatabaseSync, id: number) =>
  db.prepare('SELECT * FROM foods WHERE id = ?').get(id) as Record<string, number | string | null>

/** Everything the recipe (or a frozen copy of it) comes to, in kcal. */
const totalKcal = (db: DatabaseSync, id: number) => {
  const food = row(db, id)
  return (Number(food.kcal) * Number(food.serving_grams) * Number(food.recipe_servings ?? 1)) / 100
}

const lines = (db: DatabaseSync, id: number) =>
  db
    .prepare(
      `SELECT ri.grams, ri.serving_label, ri.serving_count, ri.is_optional, ri.is_included, f.name
       FROM recipe_ingredients ri LEFT JOIN foods f ON f.id = ri.food_id
       WHERE ri.recipe_food_id = ? ORDER BY ri.sort_order, ri.id`,
    )
    .all(id) as {
      grams: number
      serving_label: string | null
      serving_count: number | null
      is_optional: number
      is_included: number
      name: string
    }[]

describe('an optional ingredient nobody switched on', () => {
  it('is in the recipe but not in the arithmetic', async () => {
    const db = await boot()
    const { recipe } = await omelette(db)

    // 200 g egg + 35 g cheddar, and no bacon.
    expect(Number(row(db, recipe).serving_grams)).toBe(235)
    expect(totalKcal(db, recipe)).toBeCloseTo(143 * 2 + 403 * 0.35, 6)

    // Still listed, though — deleting is a different act from switching off.
    expect(lines(db, recipe)).toHaveLength(3)
  })

  it('counts once it is switched on, weight and all', async () => {
    const db = await boot()
    const { recipe, bacon } = await omelette(db)
    const { recomputeRecipeAndDependents } = await recipes()

    db.prepare('UPDATE recipe_ingredients SET is_included = 1 WHERE id = ?').run(bacon)
    recomputeRecipeAndDependents(db, recipe)

    expect(Number(row(db, recipe).serving_grams)).toBe(285)
    expect(totalKcal(db, recipe)).toBeCloseTo(143 * 2 + 403 * 0.35 + 541 * 0.5, 6)
  })
})

describe('logging a recipe with changes for one meal', () => {
  it('freezes the changes and leaves the recipe alone', async () => {
    const db = await boot()
    const { snapshotRecipeForLog } = await recipes()
    const { recipe, eggs, bacon } = await omelette(db)

    const before = totalKcal(db, recipe)
    const snapshot = snapshotRecipeForLog(db, recipe, 1, [
      // Three eggs rather than four, and the bacon on after all.
      { op: 'set', ingredient_id: eggs, grams: 150, serving_label: 'egg', serving_count: 3 },
      { op: 'set', ingredient_id: bacon, included: true },
    ])

    const frozen = lines(db, snapshot.id)
    expect(frozen).toHaveLength(3)
    expect(frozen[0]!.grams).toBe(150)
    expect(frozen[0]!.serving_count).toBe(3)
    expect(frozen[2]!.is_included).toBe(1)

    expect(totalKcal(db, snapshot.id)).toBeCloseTo(143 * 1.5 + 403 * 0.35 + 541 * 0.5, 6)
    // The recipe still says four eggs and no bacon.
    expect(totalKcal(db, recipe)).toBeCloseTo(before, 6)
    expect(lines(db, recipe)[0]!.grams).toBe(200)
    expect(lines(db, recipe)[2]!.is_included).toBe(0)
  })

  it('keeps a skipped ingredient on the record', async () => {
    const db = await boot()
    const { snapshotRecipeForLog } = await recipes()
    const { recipe, cheese } = await omelette(db)

    const snapshot = snapshotRecipeForLog(db, recipe, 1, [
      { op: 'set', ingredient_id: cheese, included: false },
    ])

    const frozen = lines(db, snapshot.id)
    // Listed, marked, and worth nothing — "no cheese" is part of what happened.
    expect(frozen.map((line) => line.name)).toEqual(['Egg', 'Cheddar', 'Bacon'])
    expect(frozen[1]!.is_included).toBe(0)
    expect(totalKcal(db, snapshot.id)).toBeCloseTo(143 * 2, 6)
  })

  it('adds something the recipe never had, and swaps another', async () => {
    const db = await boot()
    const { snapshotRecipeForLog } = await recipes()
    const { recipe, cheese, butter } = await omelette(db)

    const snapshot = snapshotRecipeForLog(db, recipe, 1, [
      { op: 'set', ingredient_id: cheese, food_id: butter },
      { op: 'add', food_id: butter, grams: 10 },
    ])

    const frozen = lines(db, snapshot.id)
    expect(frozen).toHaveLength(4)
    expect(frozen[1]!.name).toBe('Butter')
    // Appended last: the recipe, then what I put in as well.
    expect(frozen[3]!.name).toBe('Butter')
    expect(frozen[3]!.grams).toBe(10)
  })

  it('writes a note the diary can show', async () => {
    const db = await boot()
    const { snapshotRecipeForLog } = await recipes()
    const { recipe, eggs, cheese } = await omelette(db)

    const snapshot = snapshotRecipeForLog(db, recipe, 1, [
      { op: 'set', ingredient_id: eggs, grams: 150, serving_label: 'egg', serving_count: 3 },
      { op: 'set', ingredient_id: cheese, included: false },
    ])

    expect(snapshot.note).toBe('3 × egg instead of 4 × egg · no Cheddar')
    expect(row(db, snapshot.id).recipe_log_note).toBe(snapshot.note)
  })

  it('says nothing when the recipe was logged as written', async () => {
    const db = await boot()
    const { snapshotRecipeForLog } = await recipes()
    const { recipe } = await omelette(db)

    const snapshot = snapshotRecipeForLog(db, recipe, 1)
    expect(snapshot.note).toBeNull()
    expect(row(db, snapshot.id).recipe_log_note).toBeNull()
  })
})

describe('what a serving of an adjusted meal weighs', () => {
  it('is re-derived from the frozen copy, not the recipe', async () => {
    const db = await boot()
    const { resolveLoggedGrams, snapshotRecipeForLog } = await recipes()
    const { recipe, eggs } = await omelette(db)

    // A one-serving recipe's own portion is the whole thing.
    expect(resolveLoggedGrams(db, recipe, WHOLE_RECIPE_LABEL, 1)).toBe(235)

    const snapshot = snapshotRecipeForLog(db, recipe, 1, [
      { op: 'set', ingredient_id: eggs, grams: 150, serving_label: 'egg', serving_count: 3 },
    ])
    expect(resolveLoggedGrams(db, snapshot.id, WHOLE_RECIPE_LABEL, 1)).toBe(185)
  })

  it('leaves a portion entered in grams exactly as typed', async () => {
    const db = await boot()
    const { resolveLoggedGrams } = await recipes()
    const { recipe } = await omelette(db)

    // No label means the user weighed it; there is nothing to re-derive.
    expect(resolveLoggedGrams(db, recipe, null, null)).toBeNull()
    expect(resolveLoggedGrams(db, recipe, 'cup', 2)).toBeNull()
  })

  it('scales a multi-serving recipe by the count', async () => {
    const db = await boot()
    const { recomputeRecipeAndDependents, resolveLoggedGrams } = await recipes()
    const { recipe } = await omelette(db)

    db.prepare('UPDATE foods SET recipe_servings = 4 WHERE id = ?').run(recipe)
    recomputeRecipeAndDependents(db, recipe)

    expect(resolveLoggedGrams(db, recipe, SERVING_LABEL, 1)).toBeCloseTo(235 / 4, 6)
    expect(resolveLoggedGrams(db, recipe, SERVING_LABEL, 2)).toBeCloseTo(235 / 2, 6)
    expect(resolveLoggedGrams(db, recipe, WHOLE_RECIPE_LABEL, 1)).toBeCloseTo(235, 6)
  })
})

describe('correcting a meal after the fact', () => {
  it('changes the frozen copy in place, and nothing else', async () => {
    const db = await boot()
    const { resnapshotForLog, snapshotRecipeForLog } = await recipes()
    const { recipe } = await omelette(db)

    const snapshot = snapshotRecipeForLog(db, recipe, 1)
    const recipeBefore = totalKcal(db, recipe)
    // The copy's own ingredient ids, which is what the screen showing the meal
    // was drawn from.
    const frozenEggs = db
      .prepare(
        `SELECT ri.id FROM recipe_ingredients ri JOIN foods f ON f.id = ri.food_id
         WHERE ri.recipe_food_id = ? AND f.name = 'Egg'`,
      )
      .get(snapshot.id) as { id: number }

    const result = resnapshotForLog(db, snapshot.id, 1, [
      { op: 'set', ingredient_id: frozenEggs.id, grams: 150, serving_label: 'egg', serving_count: 3 },
    ])

    expect(lines(db, snapshot.id)[0]!.grams).toBe(150)
    expect(totalKcal(db, snapshot.id)).toBeCloseTo(143 * 1.5 + 403 * 0.35, 6)
    expect(result.note).toBe('3 × egg instead of 4 × egg')
    // The recipe is untouched — this was an edit to one meal.
    expect(totalKcal(db, recipe)).toBeCloseTo(recipeBefore, 6)
    expect(lines(db, recipe)[0]!.grams).toBe(200)
  })

  it('refuses a meal belonging to somebody else', async () => {
    const db = await boot()
    const { resnapshotForLog, snapshotRecipeForLog } = await recipes()
    const { recipe } = await omelette(db)
    const snapshot = snapshotRecipeForLog(db, recipe, 1)
    db.prepare("INSERT INTO users (id, email, name) VALUES (2, 'other@test', 'Other')").run()

    expect(() => resnapshotForLog(db, snapshot.id, 2, [])).toThrow()
  })

  it('refuses to be pointed at a recipe', async () => {
    const db = await boot()
    const { resnapshotForLog } = await recipes()
    const { recipe } = await omelette(db)

    // The one thing that must never work: this rewrites rows in place.
    expect(() => resnapshotForLog(db, recipe, 1, [])).toThrow()
  })
})

describe('reordering ingredients', () => {
  it('renumbers them in the order given', async () => {
    const db = await boot()
    const { reorderIngredients } = await recipes()
    const { recipe, eggs, cheese, bacon } = await omelette(db)

    reorderIngredients(db, recipe, [bacon, eggs, cheese])

    expect(lines(db, recipe).map((line) => line.name)).toEqual(['Bacon', 'Egg', 'Cheddar'])
  })

  it('refuses a partial list rather than scrambling the rest', async () => {
    const db = await boot()
    const { reorderIngredients } = await recipes()
    const { recipe, eggs, cheese } = await omelette(db)

    expect(() => reorderIngredients(db, recipe, [cheese, eggs])).toThrow(/exactly once/)
    // And nothing moved.
    expect(lines(db, recipe).map((line) => line.name)).toEqual(['Egg', 'Cheddar', 'Bacon'])
  })

  it('refuses a duplicate id, which has the right length and is still wrong', async () => {
    const db = await boot()
    const { reorderIngredients } = await recipes()
    const { recipe, eggs, cheese } = await omelette(db)

    expect(() => reorderIngredients(db, recipe, [eggs, cheese, cheese])).toThrow(/exactly once/)
  })
})

describe('variants of a recipe', () => {
  it('are linked to each other, not to a parent', async () => {
    const db = await boot()
    const { cloneRecipe, listVariants, recipeDetail } = await recipes()
    const { recipe } = await omelette(db)

    const two = cloneRecipe(db, recipe, 1, { name: 'Omelette, big', familyId: recipe })
    // A variant of the variant joins the same family rather than starting a
    // chain — "the three ways I make this" have no natural parent.
    const three = cloneRecipe(db, two, 1, { name: 'Omelette, huge', familyId: recipe })

    for (const id of [recipe, two, three]) {
      expect(Number(row(db, id).recipe_family_id)).toBe(recipe)
    }

    // Every one of them sees the other two, and never itself.
    expect(listVariants(db, recipe, recipe, 1).map((v) => v.name))
      .toEqual(['Omelette, big', 'Omelette, huge'])
    expect(listVariants(db, recipe, two, 1).map((v) => v.name))
      .toEqual(['Omelette', 'Omelette, huge'])

    const detail = recipeDetail(db, three, 1)!
    expect(detail.family_id).toBe(recipe)
    expect(detail.variants.map((v) => v.id).sort()).toEqual([recipe, two].sort())
  })

  it('survive the original being deleted', async () => {
    const db = await boot()
    const { cloneRecipe, listVariants } = await recipes()
    const { recipe } = await omelette(db)

    const two = cloneRecipe(db, recipe, 1, { name: 'Omelette, big', familyId: recipe })
    const three = cloneRecipe(db, recipe, 1, { name: 'Omelette, huge', familyId: recipe })

    // The family id is a group key, not a pointer at the first one, so deleting
    // it leaves the other two linked to each other rather than orphaned.
    db.prepare('DELETE FROM foods WHERE id = ?').run(recipe)

    expect(listVariants(db, recipe, two, 1).map((v) => v.id)).toEqual([three])
    expect(listVariants(db, recipe, three, 1).map((v) => v.id)).toEqual([two])
  })

  it('carry the adjustments that prompted them', async () => {
    const db = await boot()
    const { cloneRecipe } = await recipes()
    const { recipe, eggs, bacon } = await omelette(db)

    const light = cloneRecipe(db, recipe, 1, {
      name: 'Omelette, light',
      familyId: recipe,
      adjustments: [
        { op: 'set', ingredient_id: eggs, grams: 100, serving_label: 'egg', serving_count: 2 },
        { op: 'set', ingredient_id: bacon, included: true },
      ],
    })

    const kept = lines(db, light)
    expect(kept[0]!.grams).toBe(100)
    expect(kept[0]!.serving_count).toBe(2)
    expect(kept[2]!.is_included).toBe(1)
    // And the recipe it came from is untouched.
    expect(lines(db, recipe)[0]!.grams).toBe(200)
    expect(lines(db, recipe)[2]!.is_included).toBe(0)
  })

  it('are counted in the recipe list, and a frozen meal is not', async () => {
    const db = await boot()
    const { cloneRecipe, listRecipeSummaries, snapshotRecipeForLog } = await recipes()
    const { recipe } = await omelette(db)

    cloneRecipe(db, recipe, 1, { name: 'Omelette, big', familyId: recipe })
    snapshotRecipeForLog(db, recipe, 1)

    const summaries = listRecipeSummaries(db, 1)
    // Two recipes listed; the frozen meal is not one of them.
    expect(summaries).toHaveLength(2)
    for (const summary of summaries) {
      expect(summary.variant_count).toBe(1)
      expect(summary.family_id).toBe(recipe)
    }
  })

  it('a copy taken by somebody else starts its own family', async () => {
    const db = await boot()
    const { cloneRecipe, copyRecipeInto, listVariants } = await recipes()
    const { recipe } = await omelette(db)
    cloneRecipe(db, recipe, 1, { name: 'Omelette, big', familyId: recipe })
    db.prepare("INSERT INTO users (id, email, name) VALUES (2, 'friend@test', 'Friend')").run()

    const copy = copyRecipeInto(db, recipe, 2)

    // They copied one recipe, not a collection.
    expect(Number(row(db, copy).recipe_family_id)).toBe(copy)
    expect(listVariants(db, copy, copy, 2)).toEqual([])
    // And they can't see into the original family by guessing its id.
    expect(listVariants(db, recipe, 0, 2)).toEqual([])
  })
})

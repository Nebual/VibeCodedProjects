import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECIPE_SOURCE, WHOLE_RECIPE_LABEL } from '#shared/recipes'

/**
 * Recipe storage against a real SQLite file.
 *
 * `recomputeRecipe()` is the only thing allowed to write a recipe's nutrient
 * columns, so these tests are what stand between an edit and a food row that
 * quietly disagrees with its own ingredients.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-recipe-test-'))
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

/** A user and two foods to cook with. */
function seed(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')").run()

  const insert = db.prepare(
    `INSERT INTO foods (source, name, brand, kcal, protein_g, carbs_g, fat_g, iron_mg)
     VALUES ('off', ?, ?, ?, ?, ?, ?, ?)`,
  )
  const chicken = Number(
    insert.run('Chicken breast', 'Generic', 165, 31, 0, 3.6, 1).lastInsertRowid,
  )
  const rice = Number(insert.run('White rice', 'Generic', 130, 2.7, 28, 0.3, 0.2).lastInsertRowid)
  // Macros only — no iron figure, like a third of the imported library.
  const oil = Number(insert.run('Olive oil', 'Generic', 884, 0, 0, 100, null).lastInsertRowid)

  return { chicken, rice, oil }
}

function addIngredient(db: DatabaseSync, recipeId: number, foodId: number, grams: number) {
  db.prepare(
    'INSERT INTO recipe_ingredients (recipe_food_id, food_id, grams) VALUES (?, ?, ?)',
  ).run(recipeId, foodId, grams)
}

const foodRow = (db: DatabaseSync, id: number) =>
  db.prepare('SELECT * FROM foods WHERE id = ?').get(id) as Record<string, unknown>

describe('schema', () => {
  it('creates the recipe table on a fresh database', async () => {
    const db = await boot()
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(tables).toContain('recipe_ingredients')
  })

  it('adds the recipe columns to a database that predates them', async () => {
    // The shipped database holds 200k foods and no recipe columns, and
    // `CREATE TABLE IF NOT EXISTS` will not widen it — ALTERing them in on boot
    // is the only thing that keeps that file working. The fixture is the real
    // schema minus exactly the recipe additions, so it can't drift out of date.
    const { SCHEMA_SQL } = await import('../server/db/schema')
    const { DatabaseSync } = await import('node:sqlite')

    const legacySql = SCHEMA_SQL.replace(/^\s*recipe_(servings|final_weight_g)\s+REAL,\s*$/gm, '')
    expect(legacySql).not.toContain('recipe_servings')

    const legacy = new DatabaseSync(dbPath)
    legacy.exec(legacySql)
    legacy.exec('DROP TABLE recipe_ingredients')
    legacy.exec("INSERT INTO foods (source, name, kcal) VALUES ('off', 'Old Food', 100)")
    legacy.close()

    const db = await boot()

    const columns = (
      db.prepare('PRAGMA table_info(foods)').all() as { name: string }[]
    ).map((r) => r.name)
    expect(columns).toContain('recipe_servings')
    expect(columns).toContain('recipe_final_weight_g')

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(tables).toContain('recipe_ingredients')

    // And the 200k rows that were already there are untouched.
    const old = db.prepare("SELECT * FROM foods WHERE name = 'Old Food'").get() as Record<
      string,
      unknown
    >
    expect(old.kcal).toBe(100)
    expect(old.recipe_servings).toBeNull()
  })

  it('is safe to boot repeatedly', async () => {
    await boot()
    await boot()
    const db = await boot()
    const columns = (
      db.prepare('PRAGMA table_info(foods)').all() as { name: string }[]
    ).map((r) => r.name)
    expect(new Set(columns).size).toBe(columns.length)
  })
})

describe('recomputing a recipe', () => {
  it('writes the rolled-up nutrients onto the food row', async () => {
    const db = await boot()
    const { chicken, rice } = seed(db)
    const { createRecipeFood, recomputeRecipe } = await recipes()

    const id = createRecipeFood(db, 1, 'Chicken and rice', 4)
    addIngredient(db, id, chicken, 200)
    addIngredient(db, id, rice, 300)
    recomputeRecipe(db, id)

    const row = foodRow(db, id)
    // 720 kcal over 500 g of mixture.
    expect(row.kcal as number).toBeCloseTo(144, 6)
    expect(row.serving_grams as number).toBeCloseTo(125, 6)
    expect(row.serving_size_text).toBe('serving')
  })

  it('offers the whole recipe as a named portion', async () => {
    const db = await boot()
    const { chicken, rice } = seed(db)
    const { createRecipeFood, recomputeRecipe } = await recipes()

    const id = createRecipeFood(db, 1, 'Chicken and rice', 4)
    addIngredient(db, id, chicken, 200)
    addIngredient(db, id, rice, 300)
    recomputeRecipe(db, id)

    const servings = db
      .prepare('SELECT label, grams FROM food_servings WHERE food_id = ?')
      .all(id) as { label: string; grams: number }[]
    expect(servings).toHaveLength(1)
    expect(servings[0]!.label).toBe(WHOLE_RECIPE_LABEL)
    expect(servings[0]!.grams).toBeCloseTo(500, 6)
  })

  it('does not offer "whole recipe" twice for a single-serving recipe', async () => {
    const db = await boot()
    const { chicken } = seed(db)
    const { createRecipeFood, recomputeRecipe } = await recipes()

    const id = createRecipeFood(db, 1, 'Solo dinner', 1)
    addIngredient(db, id, chicken, 250)
    recomputeRecipe(db, id)

    expect(
      db.prepare('SELECT COUNT(*) c FROM food_servings WHERE food_id = ?').get(id),
    ).toEqual({ c: 0 })
    // The food's own serving is the whole thing, and says so.
    expect(foodRow(db, id).serving_size_text).toBe(WHOLE_RECIPE_LABEL)
    expect(foodRow(db, id).serving_grams as number).toBeCloseTo(250, 6)
  })

  it('divides the stated yield, not the raw weight, when one is given', async () => {
    const db = await boot()
    const { chicken, rice } = seed(db)
    const { createRecipeFood, recomputeRecipe } = await recipes()

    const id = createRecipeFood(db, 1, 'Reduced', 4)
    addIngredient(db, id, chicken, 200)
    addIngredient(db, id, rice, 300)
    db.prepare('UPDATE foods SET recipe_final_weight_g = 400 WHERE id = ?').run(id)
    recomputeRecipe(db, id)

    const row = foodRow(db, id)
    expect(row.serving_grams as number).toBeCloseTo(100, 6)
    expect(row.kcal as number).toBeCloseTo(180, 6) // 720 kcal / 400 g
    // A serving is still a quarter of the food: 720 / 4 = 180 kcal either way.
    expect((row.kcal as number) * ((row.serving_grams as number) / 100)).toBeCloseTo(180, 6)
  })

  it('keeps "not recorded" for a nutrient most of the mixture never declared', async () => {
    const db = await boot()
    const { chicken, oil } = seed(db)
    const { createRecipeFood, recomputeRecipe } = await recipes()

    const id = createRecipeFood(db, 1, 'Oily', 2)
    addIngredient(db, id, chicken, 100)
    addIngredient(db, id, oil, 400)
    recomputeRecipe(db, id)

    const row = foodRow(db, id)
    expect(row.iron_mg).toBeNull()
    expect(row.kcal).not.toBeNull()
  })

  it('blanks a recipe whose last ingredient was removed', async () => {
    const db = await boot()
    const { chicken } = seed(db)
    const { createRecipeFood, recomputeRecipe } = await recipes()

    const id = createRecipeFood(db, 1, 'Emptied', 2)
    addIngredient(db, id, chicken, 200)
    recomputeRecipe(db, id)
    expect(foodRow(db, id).kcal).not.toBeNull()

    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_food_id = ?').run(id)
    recomputeRecipe(db, id)

    const row = foodRow(db, id)
    // Nulls, not zeroes: an empty recipe is unknown, not calorie-free.
    expect(row.kcal).toBeNull()
    expect(row.serving_grams).toBeNull()
    expect(
      db.prepare('SELECT COUNT(*) c FROM food_servings WHERE food_id = ?').get(id),
    ).toEqual({ c: 0 })
  })

  it('leaves no serving behind when a weighed recipe is emptied', async () => {
    const db = await boot()
    const { chicken } = seed(db)
    const { createRecipeFood, recomputeRecipe } = await recipes()

    const id = createRecipeFood(db, 1, 'Weighed then emptied', 4)
    addIngredient(db, id, chicken, 200)
    db.prepare('UPDATE foods SET recipe_final_weight_g = 400 WHERE id = ?').run(id)
    recomputeRecipe(db, id)
    expect(foodRow(db, id).serving_grams as number).toBeCloseTo(100, 6)

    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_food_id = ?').run(id)
    recomputeRecipe(db, id)

    // The stated yield must not outlive the ingredients: a serving size with
    // null nutrients is a portion the diary would log for nothing.
    expect(foodRow(db, id).serving_grams).toBeNull()
    expect(foodRow(db, id).kcal).toBeNull()
  })

  it('rebuilds the whole-recipe portion instead of leaving a stale one', async () => {
    const db = await boot()
    const { chicken, rice } = seed(db)
    const { createRecipeFood, recomputeRecipe } = await recipes()

    const id = createRecipeFood(db, 1, 'Shrinking', 2)
    addIngredient(db, id, chicken, 200)
    addIngredient(db, id, rice, 300)
    recomputeRecipe(db, id)

    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_food_id = ? AND food_id = ?').run(
      id,
      rice,
    )
    recomputeRecipe(db, id)

    const rows = db
      .prepare('SELECT label, grams FROM food_servings WHERE food_id = ?')
      .all(id) as { grams: number }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.grams).toBeCloseTo(200, 6)
  })
})

describe('search index', () => {
  const matches = (db: DatabaseSync, term: string) =>
    (
      db.prepare('SELECT rowid FROM foods_fts WHERE foods_fts MATCH ?').all(term) as {
        rowid: number
      }[]
    ).map((r) => r.rowid)

  it('makes a new recipe searchable', async () => {
    const db = await boot()
    seed(db)
    const { createRecipeFood } = await recipes()
    const id = createRecipeFood(db, 1, 'Grandma Chili', 4)
    expect(matches(db, 'Chili')).toContain(id)
  })

  it('forgets the old name when a recipe is renamed', async () => {
    const db = await boot()
    seed(db)
    const { createRecipeFood, reindexFood } = await recipes()
    const id = createRecipeFood(db, 1, 'Grandma Chili', 4)

    db.prepare('UPDATE foods SET name = ? WHERE id = ?').run('Weeknight Stew', id)
    reindexFood(db, id, { name: 'Grandma Chili', brand: null }, {
      name: 'Weeknight Stew',
      brand: null,
    })

    expect(matches(db, 'Chili')).not.toContain(id)
    expect(matches(db, 'Stew')).toContain(id)
  })

  it('drops a deleted recipe out of the index', async () => {
    const db = await boot()
    seed(db)
    const { createRecipeFood, unindexFood } = await recipes()
    const id = createRecipeFood(db, 1, 'Doomed Casserole', 2)

    unindexFood(db, id, { name: 'Doomed Casserole', brand: null })
    db.prepare('DELETE FROM foods WHERE id = ?').run(id)

    expect(matches(db, 'Casserole')).not.toContain(id)
  })
})

describe('referential rules', () => {
  it('takes the ingredient rows with the recipe', async () => {
    const db = await boot()
    const { chicken } = seed(db)
    const { createRecipeFood } = await recipes()

    const id = createRecipeFood(db, 1, 'Doomed', 1)
    addIngredient(db, id, chicken, 100)
    db.prepare('DELETE FROM foods WHERE id = ?').run(id)

    expect(
      db.prepare('SELECT COUNT(*) c FROM recipe_ingredients WHERE recipe_food_id = ?').get(id),
    ).toEqual({ c: 0 })
  })

  it('refuses to delete a food a recipe is built on', async () => {
    const db = await boot()
    const { chicken } = seed(db)
    const { createRecipeFood } = await recipes()

    const id = createRecipeFood(db, 1, 'Depends on chicken', 1)
    addIngredient(db, id, chicken, 100)

    expect(() => db.prepare('DELETE FROM foods WHERE id = ?').run(chicken)).toThrow()
  })

  it('counts the diary entries that would block a delete', async () => {
    const db = await boot()
    const { chicken } = seed(db)
    const { createRecipeFood, recomputeRecipe, countDiaryUses } = await recipes()

    const id = createRecipeFood(db, 1, 'Logged twice', 2)
    addIngredient(db, id, chicken, 200)
    recomputeRecipe(db, id)

    const log = db.prepare(
      "INSERT INTO diary_entries (user_id, date, meal, food_id, grams) VALUES (1, '2026-08-16', 'lunch', ?, 100)",
    )
    log.run(id)
    log.run(id)

    expect(countDiaryUses(db, id)).toBe(2)
  })

  it('finds only the owner’s recipes', async () => {
    const db = await boot()
    seed(db)
    db.prepare("INSERT INTO users (id, email, name) VALUES (2, 'other@test', 'Other')").run()
    const { createRecipeFood, findRecipe } = await recipes()

    const id = createRecipeFood(db, 1, 'Private Chili', 2)
    expect(findRecipe(db, id, 1)?.name).toBe('Private Chili')
    // A guessed id belonging to someone else is a miss, not a leak.
    expect(findRecipe(db, id, 2)).toBeUndefined()
  })

  it('does not mistake a custom food for a recipe', async () => {
    const db = await boot()
    seed(db)
    const { findRecipe } = await recipes()
    const custom = Number(
      db
        .prepare(
          "INSERT INTO foods (source, owner_user_id, name, kcal) VALUES ('custom', 1, 'My Food', 50)",
        )
        .run().lastInsertRowid,
    )
    expect(findRecipe(db, custom, 1)).toBeUndefined()
  })

  it('reports a recipe row as a recipe', async () => {
    const db = await boot()
    seed(db)
    const { createRecipeFood } = await recipes()
    const id = createRecipeFood(db, 1, 'Sourced', 1)
    expect(foodRow(db, id).source).toBe(RECIPE_SOURCE)
  })
})

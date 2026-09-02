import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECIPE_LOG_SOURCE, RECIPE_SOURCE } from '#shared/recipes'

/**
 * Frozen meals, against a real SQLite file.
 *
 * Logging a recipe clones it into a `recipe_log` food and points the diary
 * entry at the clone. These tests are the whole guarantee that editing a recipe
 * cannot move a meal already eaten — the failure mode is silent, and shows up
 * as last Tuesday quietly gaining 90 calories.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-recipelog-test-'))
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
const foods = () => import('../server/utils/foods')

function seed(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')").run()
  const insert = db.prepare(
    `INSERT INTO foods (source, name, brand, kcal, protein_g, carbs_g, fat_g)
     VALUES ('off', ?, 'Generic', ?, ?, ?, ?)`,
  )
  return {
    egg: Number(insert.run('Egg', 143, 12.6, 0.7, 9.5).lastInsertRowid),
    cheddar: Number(insert.run('Cheddar', 403, 25, 1.3, 33).lastInsertRowid),
    butter: Number(insert.run('Butter', 717, 0.9, 0.1, 81).lastInsertRowid),
  }
}

function addIngredient(db: DatabaseSync, recipeId: number, foodId: number, grams: number) {
  db.prepare(
    'INSERT INTO recipe_ingredients (recipe_food_id, food_id, grams) VALUES (?, ?, ?)',
  ).run(recipeId, foodId, grams)
}

/** An omelette, and the diary entry that ate it. Returns both ids. */
async function logAnOmelette(db: DatabaseSync) {
  const { createRecipeFood, recomputeRecipe, snapshotRecipeForLog } = await recipes()
  const ids = seed(db)

  const omelette = createRecipeFood(db, 1, 'Omelette', 1)
  addIngredient(db, omelette, ids.egg, 200)
  addIngredient(db, omelette, ids.cheddar, 35)
  addIngredient(db, omelette, ids.butter, 10)
  recomputeRecipe(db, omelette)

  const snapshot = snapshotRecipeForLog(db, omelette, 1)
  db.prepare(
    `INSERT INTO diary_entries (user_id, date, meal, food_id, grams, serving_label, serving_count)
     VALUES (1, '2026-08-18', 'breakfast', ?, ?, 'whole recipe', 1)`,
  ).run(snapshot.id, snapshot.servingGrams)

  return { ...ids, omelette, snapshot: snapshot.id }
}

const kcalPer100 = (db: DatabaseSync, id: number) =>
  (db.prepare('SELECT kcal FROM foods WHERE id = ?').get(id) as { kcal: number }).kcal

describe('freezing a recipe when it is logged', () => {
  it('gives the entry its own copy of the recipe', async () => {
    const db = await boot()
    const { omelette, snapshot } = await logAnOmelette(db)

    const frozen = db.prepare('SELECT * FROM foods WHERE id = ?').get(snapshot) as Record<
      string,
      unknown
    >
    expect(frozen.source).toBe(RECIPE_LOG_SOURCE)
    expect(frozen.name).toBe('Omelette')
    expect(frozen.logged_from_food_id).toBe(omelette)
    expect(frozen.owner_user_id).toBe(1)
    // Same mixture, so the same numbers — freezing must not change the meal.
    expect(kcalPer100(db, snapshot)).toBeCloseTo(kcalPer100(db, omelette), 6)

    const lines = db
      .prepare('SELECT COUNT(*) AS c FROM recipe_ingredients WHERE recipe_food_id = ?')
      .get(snapshot) as { c: number }
    expect(lines.c).toBe(3)
  })

  it('editing the recipe afterwards leaves the logged meal alone', async () => {
    const db = await boot()
    const { recomputeRecipe } = await recipes()
    const { omelette, snapshot, butter } = await logAnOmelette(db)

    const before = kcalPer100(db, snapshot)

    // A second knob of butter, a week later.
    addIngredient(db, omelette, butter, 40)
    recomputeRecipe(db, omelette)

    expect(kcalPer100(db, omelette)).not.toBeCloseTo(before, 3)
    expect(kcalPer100(db, snapshot)).toBeCloseTo(before, 6)
  })

  it('keeps the frozen copy out of search and out of the recipe list', async () => {
    const db = await boot()
    const { listRecipeSummaries } = await recipes()
    const { omelette, snapshot } = await logAnOmelette(db)

    // Has to be asked with MATCH. `foods_fts` is an external-content table, so
    // selecting it by rowid reads straight through to `foods` and answers yes
    // for every row whether or not it was ever indexed — a test written that
    // way passes even when the snapshot is fully searchable.
    const hits = (
      db.prepare("SELECT rowid FROM foods_fts WHERE foods_fts MATCH 'Omelette'").all() as {
        rowid: number
      }[]
    ).map((r) => r.rowid)
    expect(hits).toEqual([omelette])

    expect(listRecipeSummaries(db, 1).map((r) => r.id)).toEqual([omelette])
  })

  it('is refused a family — a frozen meal is nobody’s variant', async () => {
    const db = await boot()
    const { omelette, snapshot } = await logAnOmelette(db)

    const rows = db.prepare('SELECT id, recipe_family_id FROM foods WHERE id IN (?, ?)')
      .all(omelette, snapshot) as { id: number; recipe_family_id: number | null }[]

    expect(rows.find((r) => r.id === omelette)!.recipe_family_id).toBe(omelette)
    expect(rows.find((r) => r.id === snapshot)!.recipe_family_id).toBeNull()
  })
})

describe('cleaning up after a deleted entry', () => {
  it('takes the frozen copy and its lines with it', async () => {
    const db = await boot()
    const { deleteRecipeLog } = await recipes()
    const { omelette, snapshot } = await logAnOmelette(db)

    db.prepare('DELETE FROM diary_entries WHERE food_id = ?').run(snapshot)
    deleteRecipeLog(db, snapshot, 1)

    const food = db.prepare('SELECT id FROM foods WHERE id = ?').get(snapshot)
    expect(food).toBeUndefined()

    const orphans = db
      .prepare('SELECT COUNT(*) AS c FROM recipe_ingredients WHERE recipe_food_id = ?')
      .get(snapshot) as { c: number }
    expect(orphans.c).toBe(0)

    // The recipe itself is untouched.
    expect(db.prepare('SELECT id FROM foods WHERE id = ?').get(omelette)).toBeTruthy()
  })

  it('refuses to delete anything that is not a frozen copy', async () => {
    const db = await boot()
    const { deleteRecipeLog } = await recipes()
    const { omelette, egg } = await logAnOmelette(db)

    // Handed the recipe, and an ordinary food, by mistake.
    deleteRecipeLog(db, omelette, 1)
    deleteRecipeLog(db, egg, 1)

    expect(db.prepare('SELECT id FROM foods WHERE id = ?').get(omelette)).toBeTruthy()
    expect(db.prepare('SELECT id FROM foods WHERE id = ?').get(egg)).toBeTruthy()
  })

  it('refuses a frozen copy belonging to someone else', async () => {
    const db = await boot()
    const { deleteRecipeLog } = await recipes()
    const { snapshot } = await logAnOmelette(db)
    db.prepare("INSERT INTO users (id, email, name) VALUES (2, 'other@test', 'Other')").run()

    deleteRecipeLog(db, snapshot, 2)

    expect(db.prepare('SELECT id FROM foods WHERE id = ?').get(snapshot)).toBeTruthy()
  })
})

describe('a recipe that has been eaten', () => {
  it('can be deleted, and the meals survive it', async () => {
    const db = await boot()
    const { countDiaryUses, unindexFood } = await recipes()
    const { omelette, snapshot } = await logAnOmelette(db)

    // Nothing points at the recipe any more, which is what the delete route
    // checks before it will go ahead.
    expect(countDiaryUses(db, omelette)).toBe(0)

    unindexFood(db, omelette, { name: 'Omelette', brand: null })
    db.prepare('DELETE FROM foods WHERE id = ?').run(omelette)

    const frozen = db.prepare('SELECT logged_from_food_id, kcal FROM foods WHERE id = ?')
      .get(snapshot) as { logged_from_food_id: number | null; kcal: number }
    expect(frozen.logged_from_food_id).toBeNull()
    expect(frozen.kcal).toBeGreaterThan(0)

    const entries = db.prepare('SELECT COUNT(*) AS c FROM diary_entries').get() as { c: number }
    expect(entries.c).toBe(1)
  })
})

describe('Frequent', () => {
  it('counts a recipe eaten twice as one recipe, not two frozen meals', async () => {
    const db = await boot()
    const { snapshotRecipeForLog } = await recipes()
    const { listFrequentFoods } = await foods()
    const { omelette } = await logAnOmelette(db)

    const second = snapshotRecipeForLog(db, omelette, 1)
    db.prepare(
      `INSERT INTO diary_entries (user_id, date, meal, food_id, grams)
       VALUES (1, '2026-08-19', 'breakfast', ?, ?)`,
    ).run(second.id, second.servingGrams)

    const results = listFrequentFoods(db, 1) as { id: number; name: string; times_logged: number }[]

    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe(omelette)
    expect(results[0]!.name).toBe('Omelette')
    expect(results[0]!.times_logged).toBe(2)
  })

  it('drops a frozen meal whose recipe has been deleted', async () => {
    const db = await boot()
    const { listFrequentFoods } = await foods()
    const { omelette } = await logAnOmelette(db)

    db.prepare('DELETE FROM foods WHERE id = ?').run(omelette)

    expect(listFrequentFoods(db, 1)).toEqual([])
  })

  it('still lists plain foods', async () => {
    const db = await boot()
    const { listFrequentFoods } = await foods()
    const { egg } = await logAnOmelette(db)

    db.prepare(
      `INSERT INTO diary_entries (user_id, date, meal, food_id, grams)
       VALUES (1, '2026-08-18', 'snack', ?, 50)`,
    ).run(egg)

    const results = listFrequentFoods(db, 1) as { id: number; times_logged: number }[]
    expect(results.map((r) => r.id)).toContain(egg)
  })
})

describe('migrating a database that predates frozen meals', () => {
  it('adds the columns, indexes them, and gives every recipe a family', async () => {
    const { SCHEMA_SQL } = await import('../server/db/schema')
    const { DatabaseSync } = await import('node:sqlite')

    // Derived from the real schema so the fixture cannot drift: strip exactly
    // the three columns this change adds, and the indexes over them are then
    // uncreatable until migrate() has run — which is the thing being tested.
    const legacySql = SCHEMA_SQL
      .replace(/^\s*logged_from_food_id\s+INTEGER REFERENCES foods\(id\) ON DELETE SET NULL,\s*$/m, '')
      .replace(/^\s*recipe_log_note\s+TEXT,\s*$/m, '')
      .replace(/^\s*recipe_family_id\s+INTEGER,\s*$/m, '')
    // The declaration, not the word: `recipe_family_id` is named in the comment
    // above it too, and asserting on the bare string passes a stripped schema
    // that still declares the column.
    expect(legacySql).not.toMatch(/^\s*recipe_family_id\s+INTEGER,/m)
    expect(legacySql).not.toMatch(/^\s*logged_from_food_id\s+INTEGER/m)

    const legacy = new DatabaseSync(dbPath)
    legacy.exec(legacySql)
    legacy.exec("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')")
    legacy.exec(
      `INSERT INTO foods (id, source, owner_user_id, name, recipe_servings)
       VALUES (900, 'recipe', 1, 'Old Chili', 4)`,
    )
    legacy.exec("INSERT INTO foods (id, source, name, kcal) VALUES (901, 'off', 'Old Food', 100)")
    legacy.close()

    const db = await boot()

    const columns = (db.prepare('PRAGMA table_info(foods)').all() as { name: string }[])
      .map((r) => r.name)
    expect(columns).toContain('logged_from_food_id')
    expect(columns).toContain('recipe_log_note')
    expect(columns).toContain('recipe_family_id')

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(indexes).toContain('idx_foods_recipe_family')
    expect(indexes).toContain('idx_foods_logged_from')

    // The existing recipe founds its own family; a plain food gets nothing.
    const chili = db.prepare('SELECT recipe_family_id FROM foods WHERE id = 900').get() as {
      recipe_family_id: number | null
    }
    expect(chili.recipe_family_id).toBe(900)
    const plain = db.prepare('SELECT recipe_family_id FROM foods WHERE id = 901').get() as {
      recipe_family_id: number | null
    }
    expect(plain.recipe_family_id).toBeNull()
  })
})

describe('copying still works the way it did', () => {
  it('gives the copy its own family and no trace of a frozen meal', async () => {
    const db = await boot()
    const { copyRecipeInto } = await recipes()
    const { omelette } = await logAnOmelette(db)
    db.prepare("INSERT INTO users (id, email, name) VALUES (2, 'friend@test', 'Friend')").run()

    const copy = copyRecipeInto(db, omelette, 2)
    const row = db.prepare('SELECT * FROM foods WHERE id = ?').get(copy) as Record<string, unknown>

    expect(row.source).toBe(RECIPE_SOURCE)
    expect(row.recipe_family_id).toBe(copy)
    expect(row.logged_from_food_id).toBeNull()
    expect(row.owner_user_id).toBe(2)
    expect(kcalPer100(db, copy)).toBeCloseTo(kcalPer100(db, omelette), 6)
  })
})

describe('amount_formula on a frozen meal', () => {
  it('carries the amount formula onto the frozen copy', async () => {
    const db = await boot()
    const { createRecipeFood, recomputeRecipe, snapshotRecipeForLog } = await recipes()
    const ids = seed(db)

    const omelette = createRecipeFood(db, 1, 'Omelette', 1)
    addIngredient(db, omelette, ids.egg, 200)
    db.prepare("UPDATE recipe_ingredients SET amount_formula = '2x3' WHERE recipe_food_id = ?")
      .run(omelette)
    recomputeRecipe(db, omelette)

    const snapshot = snapshotRecipeForLog(db, omelette, 1)

    const row = db
      .prepare('SELECT amount_formula FROM recipe_ingredients WHERE recipe_food_id = ?')
      .get(snapshot.id) as { amount_formula: string | null }
    expect(row.amount_formula).toBe('2x3')
  })
})

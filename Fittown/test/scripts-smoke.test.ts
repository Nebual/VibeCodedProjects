import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_SQL } from '../server/db/schema'

/**
 * The maintenance scripts, run the way a person runs them: `node scripts/x.mjs`.
 *
 * Not a duplicate of the unit tests around the same functions. These spawn real
 * `node`, which resolves ESM specifiers **literally** — so an import written
 * without its `.ts` extension works everywhere in Nuxt, Vite and Vitest and
 * fails only here, with a bare ERR_MODULE_NOT_FOUND at the moment somebody is
 * migrating their live database. That has now happened twice (AGENTS.md §5), and
 * nothing else in the suite can see it.
 *
 * They also stand for the other half of the problem: a script opens the
 * database itself, so it must apply pending column additions rather than
 * assuming the app has booted since the last release.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-scripts-test-'))
  dbPath = join(dir, 'legacy.db')
  buildLegacyDatabase(dbPath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A database in the shape one that has not been served since this feature
 * shipped is in: recipes and diary entries logged the old way, pointing straight
 * at the recipe, and none of the columns freezing a meal needs.
 *
 * Derived from the real schema by stripping exactly those columns, so it cannot
 * drift out of date.
 */
function buildLegacyDatabase(path: string) {
  const legacy = SCHEMA_SQL
    .replace(/^\s*logged_from_food_id\s+INTEGER REFERENCES foods\(id\) ON DELETE SET NULL,\s*$/m, '')
    .replace(/^\s*recipe_log_note\s+TEXT,\s*$/m, '')
    .replace(/^\s*recipe_family_id\s+INTEGER,\s*$/m, '')
  expect(legacy).not.toMatch(/^\s*recipe_family_id\s+INTEGER,/m)

  const db = new DatabaseSync(path)
  db.exec(legacy)
  db.exec("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')")

  const insert = db.prepare(
    "INSERT INTO foods (source, name, kcal, protein_g, carbs_g, fat_g) VALUES ('off', ?, ?, ?, ?, ?)",
  )
  const egg = Number(insert.run('Egg', 143, 12.6, 0.7, 9.5).lastInsertRowid)
  const cheese = Number(insert.run('Cheddar', 403, 25, 1.3, 33).lastInsertRowid)

  // Built by hand rather than through createRecipeFood(), which writes one of
  // the columns this fixture is supposed to be missing.
  const recipe = Number(
    db
      .prepare(
        `INSERT INTO foods (source, owner_user_id, name, is_liquid, recipe_servings)
         VALUES ('recipe', 1, 'Omelette', 0, 2)`,
      )
      .run().lastInsertRowid,
  )
  db.prepare('INSERT INTO foods_fts(rowid, name, brand) VALUES (?, ?, NULL)').run(recipe, 'Omelette')
  const line = db.prepare(
    'INSERT INTO recipe_ingredients (recipe_food_id, food_id, grams) VALUES (?, ?, ?)',
  )
  line.run(recipe, egg, 200)
  line.run(recipe, cheese, 40)

  // The cached per-100 g figures, as recomputeRecipe() would have left them:
  // 286 + 161.2 kcal over 240 g, two servings.
  const total = 143 * 2 + 403 * 0.4
  db.prepare(
    'UPDATE foods SET kcal = ?, serving_grams = 120, serving_size_text = ? WHERE id = ?',
  ).run((total / 240) * 100, 'serving', recipe)
  db.prepare(
    "INSERT INTO food_servings (food_id, label, grams, is_default) VALUES (?, 'whole recipe', 240, 0)",
  ).run(recipe)

  for (const date of ['2026-08-16', '2026-08-17']) {
    db.prepare(
      `INSERT INTO diary_entries (user_id, date, meal, food_id, grams, serving_label, serving_count)
       VALUES (1, ?, 'breakfast', ?, 120, 'serving', 1)`,
    ).run(date, recipe)
  }
  // A plain food, which must be left alone throughout.
  db.prepare(
    "INSERT INTO diary_entries (user_id, date, meal, food_id, grams) VALUES (1, '2026-08-16', 'snack', ?, 50)",
  ).run(egg)

  db.close()
}

/** Run a script the way a person does, and hand back what it printed. */
function runScript(script: string, args: string[] = []): string {
  return execFileSync('node', [join('scripts', script), dbPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const query = <T>(sql: string): T => {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare(sql).all() as T
  } finally {
    db.close()
  }
}

describe('snapshot-diary-recipes.mjs', () => {
  it('migrates the database it was handed, then reports what it would freeze', () => {
    const out = runScript('snapshot-diary-recipes.mjs')

    expect(out).toContain('logged_from_food_id')
    expect(out).toMatch(/2 entries to freeze/)
    expect(out).toMatch(/Dry run/)
    expect(out).toMatch(/no day's total moved/)

    // A dry run repoints nothing. (The schema catch-up is not part of the
    // transaction and does stay — it is idempotent and additive.)
    const entries = query<{ source: string }[]>(
      `SELECT f.source FROM diary_entries d JOIN foods f ON f.id = d.food_id WHERE f.source = 'recipe'`,
    )
    expect(entries).toHaveLength(2)
  })

  it('freezes them on --commit, without moving a single day', () => {
    const before = query<{ date: string; kcal: number }[]>(
      `SELECT d.date, SUM(f.kcal * d.grams / 100.0) AS kcal
       FROM diary_entries d JOIN foods f ON f.id = d.food_id GROUP BY d.date ORDER BY d.date`,
    )

    const out = runScript('snapshot-diary-recipes.mjs', ['--commit'])
    expect(out).toMatch(/Froze 2 entries/)

    const rows = query<{ source: string; from_id: number | null }[]>(
      `SELECT f.source, f.logged_from_food_id AS from_id
       FROM diary_entries d JOIN foods f ON f.id = d.food_id
       WHERE d.meal = 'breakfast'`,
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.source).toBe('recipe_log')
      expect(row.from_id).not.toBeNull()
    }

    const after = query<{ date: string; kcal: number }[]>(
      `SELECT d.date, SUM(f.kcal * d.grams / 100.0) AS kcal
       FROM diary_entries d JOIN foods f ON f.id = d.food_id GROUP BY d.date ORDER BY d.date`,
    )

    // Compared to within a hundredth of a calorie, which is the guarantee the
    // script actually makes and enforces. Not bit-equality: the frozen copy's
    // per-100 g figure is re-derived from the ingredients rather than copied, so
    // it can land a few parts in 10^14 away (295.1 became 295.09999999999997
    // when this was first written). Asserting exact equality here would make the
    // test stricter than the thing it is testing, and fail on arithmetic nobody
    // could act on.
    expect(after.map((row) => row.date)).toEqual(before.map((row) => row.date))
    for (const [index, row] of after.entries()) {
      expect(row.kcal).toBeCloseTo(before[index]!.kcal, 2)
    }

    // Idempotent: a second run finds nothing left to do.
    expect(runScript('snapshot-diary-recipes.mjs', ['--commit'])).toMatch(/Nothing to do/)
  })
})

describe('recompute-recipes.mjs', () => {
  it('runs against a database that predates the current schema', () => {
    const out = runScript('recompute-recipes.mjs')
    expect(out).toMatch(/Recomputed 1 recipe/)
  })
})

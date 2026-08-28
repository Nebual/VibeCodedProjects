import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITIES } from '#shared/activities'

/**
 * Boot-time database behaviour, against a real SQLite file.
 *
 * These cover the two things that go quietly and expensively wrong: a returning
 * user's database not gaining new columns ("no such column" on every request),
 * and an exercise re-sync re-pointing existing workouts at different
 * activities. Both were verified by hand once; this keeps them verified.
 *
 * `useDb()` caches its connection in a module-level variable and reads
 * FITTOWN_DB_PATH when first called, so each test resets the module registry
 * to get a fresh boot against a fresh temp file.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-test-'))
  dbPath = join(dir, 'test.db')
  process.env.FITTOWN_DB_PATH = dbPath
  vi.resetModules()
})

afterEach(() => {
  delete process.env.FITTOWN_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** Boot the app's database layer, as a request would. */
async function boot() {
  vi.resetModules()
  const { useDb } = await import('../server/utils/db')
  return useDb()
}

/** Open the same file independently, to inspect what boot actually wrote. */
function inspect() {
  return new DatabaseSync(dbPath, { readOnly: true })
}

const tableNames = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string
  }[]).map((r) => r.name)

const columnNames = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)

describe('fresh database', () => {
  it('creates every table the app needs', async () => {
    await boot()
    const db = inspect()
    const tables = tableNames(db)
    for (const table of [
      'users', 'user_goals', 'foods', 'foods_fts', 'food_servings',
      'diary_entries', 'water_entries', 'daily_goal_adjustments', 'exercises',
      'exercise_categories', 'workout_entries', 'weight_entries',
      'biometric_types', 'biometric_entries',
    ]) {
      expect(tables, `missing table ${table}`).toContain(table)
    }
  })

  it('defaults a new user to a 20/50/30 macro split', async () => {
    const db = await boot()
    db.prepare("INSERT INTO users (email, name) VALUES ('a@b.c', 'A')").run()
    db.prepare('INSERT INTO user_goals (user_id) VALUES (1)').run()

    const goals = db.prepare('SELECT * FROM user_goals WHERE user_id = 1').get() as Record<
      string,
      number
    >
    expect(goals.calorie_goal).toBe(2000)
    expect((goals.protein_g * 4) / goals.calorie_goal).toBeCloseTo(0.2, 2)
    expect((goals.carbs_g * 4) / goals.calorie_goal).toBeCloseTo(0.5, 2)
    expect((goals.fat_g * 9) / goals.calorie_goal).toBeCloseTo(0.3, 2)
  })
})

describe('migrating an existing database', () => {
  /**
   * The `user_goals` shape as it shipped before body metrics existed. A
   * returning user's file looks exactly like this, and `CREATE TABLE IF NOT
   * EXISTS` will not touch it.
   */
  function createLegacyDatabase() {
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_sub TEXT UNIQUE,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE user_goals (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        calorie_goal REAL NOT NULL DEFAULT 2000,
        protein_g REAL NOT NULL DEFAULT 150,
        carbs_g REAL NOT NULL DEFAULT 200,
        fat_g REAL NOT NULL DEFAULT 65,
        fiber_g REAL NOT NULL DEFAULT 30,
        water_goal_ml REAL NOT NULL DEFAULT 2500,
        weight_unit TEXT NOT NULL DEFAULT 'kg',
        volume_unit TEXT NOT NULL DEFAULT 'ml',
        exercise_adds_calories INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (id, email, name) VALUES (1, 'old@user.test', 'Old User');
      INSERT INTO user_goals (user_id, calorie_goal, protein_g) VALUES (1, 2400, 180);
    `)
    db.close()
  }

  it('adds the columns that were introduced later', async () => {
    createLegacyDatabase()
    expect(columnNames(inspect(), 'user_goals')).not.toContain('activity_level')

    await boot()

    const columns = columnNames(inspect(), 'user_goals')
    for (const column of [
      'sex', 'birth_year', 'height_cm', 'height_unit', 'food_system',
      'portion_default', 'activity_level', 'goal_weight_kg', 'goal_rate_kg_per_week',
    ]) {
      expect(columns, `migration missed ${column}`).toContain(column)
    }
  })

  it('keeps the existing rows and their values', async () => {
    createLegacyDatabase()
    await boot()

    const goals = inspect()
      .prepare('SELECT * FROM user_goals WHERE user_id = 1')
      .get() as Record<string, unknown>
    // The user's own settings survive; the new columns arrive with defaults.
    expect(goals.calorie_goal).toBe(2400)
    expect(goals.protein_g).toBe(180)
    expect(goals.height_unit).toBe('cm')
    expect(goals.food_system).toBe('metric')
    // Existing users keep opening on servings, which is all they have ever done.
    expect(goals.portion_default).toBe('serving')
    expect(goals.activity_level).toBeNull()
  })

  it('creates the tables a legacy database never had', async () => {
    createLegacyDatabase()
    await boot()
    const tables = tableNames(inspect())
    expect(tables).toContain('biometric_types')
    expect(tables).toContain('exercise_categories')
  })

  it('is safe to run repeatedly', async () => {
    createLegacyDatabase()
    await boot()
    await boot()
    await boot()

    const columns = columnNames(inspect(), 'user_goals')
    // No duplicated columns, and still exactly one row.
    expect(new Set(columns).size).toBe(columns.length)
    expect(
      (inspect().prepare('SELECT COUNT(*) c FROM user_goals').get() as { c: number }).c,
    ).toBe(1)
  })
})

describe('exercise library sync', () => {
  it('loads the whole library with its categories', async () => {
    await boot()
    const db = inspect()

    const shared = (
      db.prepare('SELECT COUNT(*) c FROM exercises WHERE owner_user_id IS NULL').get() as {
        c: number
      }
    ).c
    expect(shared).toBe(ACTIVITIES.length)

    const expectedLinks = ACTIVITIES.reduce((sum, a) => sum + a.categories.length, 0)
    expect(
      (db.prepare('SELECT COUNT(*) c FROM exercise_categories').get() as { c: number }).c,
    ).toBe(expectedLinks)
  })

  it('splits MET values across the right columns', async () => {
    await boot()
    const db = inspect()
    const row = (name: string) =>
      db.prepare('SELECT * FROM exercises WHERE name = ?').get(name) as Record<string, unknown>

    // An activity with measured light/moderate/vigorous rows.
    const scrubbing = row('Scrubbing floors or bathroom')
    expect(scrubbing.met_light).toBe(2.0)
    expect(scrubbing.met).toBe(3.5)
    expect(scrubbing.met_hard).toBe(6.5)

    // A flat one: nulls are what tell the UI to hide the effort picker.
    const dishes = row('Washing dishes')
    expect(dishes.met).toBe(2.0)
    expect(dishes.met_light).toBeNull()
    expect(dishes.met_hard).toBeNull()
  })

  it('records which activities want sets or distance', async () => {
    await boot()
    const db = inspect()
    const row = (name: string) =>
      db.prepare('SELECT tracks_sets, tracks_distance FROM exercises WHERE name = ?').get(name) as {
        tracks_sets: number
        tracks_distance: number
      }
    expect(row('Weight training')).toEqual({ tracks_sets: 1, tracks_distance: 0 })
    expect(row('Running')).toEqual({ tracks_sets: 0, tracks_distance: 1 })
    expect(row('Vacuuming')).toEqual({ tracks_sets: 0, tracks_distance: 0 })
  })

  it('keeps exercise ids stable across a re-sync', async () => {
    await boot()
    const idOf = (name: string) =>
      (inspect().prepare('SELECT id FROM exercises WHERE name = ?').get(name) as { id: number }).id

    const before = idOf('Running')
    await boot()
    await boot()

    // Workouts reference these ids. If a re-sync renumbered them, last
    // month's run would silently become a different activity.
    expect(idOf('Running')).toBe(before)
  })

  it('does not duplicate category rows on a re-sync', async () => {
    await boot()
    const count = () =>
      (inspect().prepare('SELECT COUNT(*) c FROM exercise_categories').get() as { c: number }).c
    const before = count()
    await boot()
    expect(count()).toBe(before)
  })

  it('picks up a corrected MET value on the next boot', async () => {
    const db = await boot()
    db.prepare("UPDATE exercises SET met = 99 WHERE name = 'Vacuuming'").run()

    await boot()

    const met = (
      inspect().prepare("SELECT met FROM exercises WHERE name = 'Vacuuming'").get() as {
        met: number
      }
    ).met
    expect(met).toBe(3.0)
  })

  it('retires an activity nobody has logged', async () => {
    const db = await boot()
    db.prepare(
      "INSERT INTO exercises (name, category, met, owner_user_id) VALUES ('Obsolete Activity', 'cardio', 5, NULL)",
    ).run()

    await boot()

    expect(
      inspect().prepare("SELECT id FROM exercises WHERE name = 'Obsolete Activity'").get(),
    ).toBeUndefined()
  })

  it('keeps a retired activity that someone has logged', async () => {
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@b.c', 'A')").run()
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO exercises (name, category, met, owner_user_id) VALUES ('Retired Activity', 'cardio', 5, NULL)",
      )
      .run()
    db.prepare(
      `INSERT INTO workout_entries (user_id, date, exercise_id, duration_min, calories)
       VALUES (1, '2026-08-01', ?, 30, 200)`,
    ).run(Number(lastInsertRowid))

    await boot()

    // History outlives a tidy library.
    const kept = inspect()
      .prepare("SELECT id FROM exercises WHERE name = 'Retired Activity'")
      .get() as { id: number } | undefined
    expect(kept?.id).toBe(Number(lastInsertRowid))
  })

  it('leaves a user’s own exercises alone', async () => {
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@b.c', 'A')").run()
    db.prepare(
      "INSERT INTO exercises (name, category, met, owner_user_id) VALUES ('My Weird Sport', 'cardio', 7, 1)",
    ).run()

    await boot()

    const mine = inspect()
      .prepare("SELECT met FROM exercises WHERE name = 'My Weird Sport'")
      .get() as { met: number } | undefined
    expect(mine?.met).toBe(7)
  })

  it('lets a custom exercise share a name with a library one', async () => {
    // The unique index is partial (shared rows only), so two households can
    // each have their own "Running" without colliding with the library's.
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@b.c', 'A')").run()
    expect(() =>
      db
        .prepare(
          "INSERT INTO exercises (name, category, met, owner_user_id) VALUES ('Running', 'cardio', 9, 1)",
        )
        .run(),
    ).not.toThrow()
  })
})

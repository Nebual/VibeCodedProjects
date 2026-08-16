import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SCHEMA_SQL } from '../db/schema'
import { ACTIVITIES, metColumns } from '#shared/activities'

let db: DatabaseSync | null = null

/**
 * Resolve the database file location.
 *
 * Defaults to `<project>/data/fittown.db` so a fresh checkout just works, but
 * deployments should set FITTOWN_DB_PATH to somewhere outside the app
 * directory (e.g. /var/lib/fittown/fittown.db) so upgrades never touch data.
 */
function dbPath(): string {
  const configured = process.env.FITTOWN_DB_PATH
  return configured
    ? resolve(configured)
    : resolve(process.cwd(), 'data/fittown.db')
}

/**
 * Open (once) and return the shared connection.
 *
 * node:sqlite is synchronous, which is fine here: SQLite reads are served from
 * page cache in microseconds, and this app's write volume is a handful of rows
 * per meal. WAL mode keeps readers from blocking the writer.
 */
export function useDb(): DatabaseSync {
  if (db) return db

  const path = dbPath()
  mkdirSync(dirname(path), { recursive: true })

  db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // Wait rather than immediately throwing SQLITE_BUSY if another process
  // (notably the OFF importer) holds the write lock.
  db.exec('PRAGMA busy_timeout = 10000')
  db.exec('PRAGMA synchronous = NORMAL')

  db.exec(SCHEMA_SQL)
  migrate(db)
  syncExerciseLibrary(db)

  return db
}

/**
 * Columns added to a table after it first shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * SCHEMA_SQL alone never widens an existing database — a returning user would
 * get "no such column" on boot. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * hence the table_info check below.
 *
 * Entries stay here permanently: they are how an old database catches up, and
 * they are cheap (one PRAGMA per table per boot). Anything added here must
 * also be added to SCHEMA_SQL, which is what a fresh database uses.
 */
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  user_goals: {
    sex: 'TEXT',
    birth_year: 'INTEGER',
    height_cm: 'REAL',
    height_unit: "TEXT NOT NULL DEFAULT 'cm'",
    food_system: "TEXT NOT NULL DEFAULT 'metric'",
    activity_level: 'TEXT',
    goal_weight_kg: 'REAL',
    goal_rate_kg_per_week: 'REAL',
  },
  exercises: {
    met_light: 'REAL',
    met_hard: 'REAL',
    tracks_sets: 'INTEGER NOT NULL DEFAULT 0',
    tracks_distance: 'INTEGER NOT NULL DEFAULT 0',
    hint: 'TEXT',
  },
  workout_entries: {
    effort: 'TEXT',
  },
  // Recipes. Null on the 200k+ imported rows, which costs a byte each in the
  // record header and saves a second table to join on every food query.
  foods: {
    recipe_servings: 'REAL',
    recipe_final_weight_g: 'REAL',
    sugar_alcohols_g: 'REAL',
  },
}

function migrate(conn: DatabaseSync) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(
      (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((row) => row.name),
    )
    for (const [name, declaration] of Object.entries(columns)) {
      if (existing.has(name)) continue
      conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`)
    }
  }
}

/**
 * Bring the shared exercise library in line with `shared/activities.ts`.
 *
 * Runs on every boot rather than once, so editing the library file is all it
 * takes to ship a corrected MET value. Upserting **on name** matters: ids stay
 * stable, and `workout_entries` reference them, so a re-sync must never make
 * last month's run point at a different activity.
 *
 * Rows that have dropped out of the library are deleted only when nothing has
 * ever been logged against them — someone's history is worth more than a tidy
 * table, so a retired activity with entries simply stays.
 */
function syncExerciseLibrary(conn: DatabaseSync) {
  const upsert = conn.prepare(
    `INSERT INTO exercises
       (name, category, met, met_light, met_hard, tracks_sets, tracks_distance,
        hint, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(name) WHERE owner_user_id IS NULL DO UPDATE SET
       category        = excluded.category,
       met             = excluded.met,
       met_light       = excluded.met_light,
       met_hard        = excluded.met_hard,
       tracks_sets     = excluded.tracks_sets,
       tracks_distance = excluded.tracks_distance,
       hint            = excluded.hint`,
  )
  const findId = conn.prepare(
    'SELECT id FROM exercises WHERE name = ? AND owner_user_id IS NULL',
  )
  const clearCategories = conn.prepare(
    'DELETE FROM exercise_categories WHERE exercise_id = ?',
  )
  const addCategory = conn.prepare(
    'INSERT OR IGNORE INTO exercise_categories (exercise_id, category) VALUES (?, ?)',
  )

  conn.exec('BEGIN')
  try {
    for (const activity of ACTIVITIES) {
      const mets = metColumns(activity.met)
      upsert.run(
        activity.name,
        activity.categories[0]!,
        mets.met,
        mets.met_light,
        mets.met_hard,
        activity.tracks?.includes('sets') ? 1 : 0,
        activity.tracks?.includes('distance') ? 1 : 0,
        activity.hint ?? null,
      )
      const { id } = findId.get(activity.name) as { id: number }
      clearCategories.run(id)
      for (const category of activity.categories) addCategory.run(id, category)
    }

    const names = ACTIVITIES.map((a) => a.name)
    conn
      .prepare(
        `DELETE FROM exercises
         WHERE owner_user_id IS NULL
           AND name NOT IN (${names.map(() => '?').join(',')})
           AND id NOT IN (SELECT DISTINCT exercise_id FROM workout_entries)`,
      )
      .run(...names)

    conn.exec('COMMIT')
  } catch (err) {
    conn.exec('ROLLBACK')
    throw err
  }
}

/** Run `fn` inside a transaction, rolling back on throw. */
export function transact<T>(fn: (conn: DatabaseSync) => T): T {
  const conn = useDb()
  conn.exec('BEGIN')
  try {
    const result = fn(conn)
    conn.exec('COMMIT')
    return result
  } catch (err) {
    conn.exec('ROLLBACK')
    throw err
  }
}

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SCHEMA_SQL } from '../db/schema'
import { SEED_EXERCISES } from '../db/seed-exercises'

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
  seedExercises(db)

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

/** Populate the shared exercise library on first boot. */
function seedExercises(conn: DatabaseSync) {
  const { c } = conn
    .prepare('SELECT COUNT(*) AS c FROM exercises WHERE owner_user_id IS NULL')
    .get() as { c: number }
  if (c > 0) return

  const insert = conn.prepare(
    'INSERT INTO exercises (name, category, met, owner_user_id) VALUES (?, ?, ?, NULL)',
  )
  conn.exec('BEGIN')
  try {
    for (const [name, category, met] of SEED_EXERCISES) {
      insert.run(name, category, met)
    }
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

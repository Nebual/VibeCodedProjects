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
  seedExercises(db)

  return db
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

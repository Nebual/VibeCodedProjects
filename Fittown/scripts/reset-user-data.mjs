#!/usr/bin/env node
/**
 * Strip all personal data from a database, keeping the food and exercise
 * libraries. Useful for handing someone a pre-imported database, or for
 * resetting a test instance.
 *
 *   node scripts/reset-user-data.mjs [db-path] [--out clean.db]
 */
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { rmSync } from 'node:fs'

const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const out = outFlag !== -1 ? args[outFlag + 1] : null
const dbFile = resolve(
  args.find((a) => !a.startsWith('--') && a !== out) ||
    process.env.FITTOWN_DB_PATH ||
    'data/fittown.db',
)

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 15000')
db.exec('PRAGMA foreign_keys = ON')

const before = {
  users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
  entries: db.prepare('SELECT COUNT(*) c FROM diary_entries').get().c,
  foods: db.prepare('SELECT COUNT(*) c FROM foods').get().c,
}

db.exec('BEGIN')
// Custom foods belong to users; drop them with their FTS rows first so the
// index doesn't keep pointing at deleted content.
const customIds = db
  .prepare("SELECT id FROM foods WHERE source = 'custom'")
  .all()
  .map((r) => r.id)
const delFts = db.prepare('DELETE FROM foods_fts WHERE rowid = ?')
for (const id of customIds) delFts.run(id)

db.exec("DELETE FROM foods WHERE source = 'custom'")
db.exec('DELETE FROM diary_entries')
db.exec('DELETE FROM water_entries')
db.exec('DELETE FROM workout_entries')
db.exec('DELETE FROM weight_entries')
// These would cascade from `users`, but only while foreign keys are enforced.
// Personal data is not something to leave depending on a PRAGMA.
db.exec('DELETE FROM biometric_entries')
db.exec('DELETE FROM biometric_types')
db.exec('DELETE FROM exercises WHERE owner_user_id IS NOT NULL')
db.exec('DELETE FROM user_goals')
db.exec('DELETE FROM users')
db.exec('COMMIT')

if (out) {
  const target = resolve(out)
  rmSync(target, { force: true })
  rmSync(`${target}-wal`, { force: true })
  rmSync(`${target}-shm`, { force: true })
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  console.log(`Wrote clean database to ${target}`)
} else {
  db.exec('VACUUM')
}

console.log(
  `Removed ${before.users} user(s), ${before.entries} diary entries, ` +
    `${customIds.length} custom foods. ${before.foods - customIds.length} foods kept.`,
)
db.close()

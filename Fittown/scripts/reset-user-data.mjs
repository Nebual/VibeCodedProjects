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

// Entries first. `diary_entries.food_id` is ON DELETE RESTRICT, so deleting a
// user's foods while their meals still point at them fails outright — and a
// recipe is a food that exists *in order to* be logged, so this is the normal
// case rather than an edge one.
db.exec('DELETE FROM diary_entries')

// Custom foods and recipes both belong to users; drop them with their FTS rows
// so the index doesn't keep pointing at deleted content. Recipe ingredient rows
// go with their recipe: recipe_food_id is ON DELETE CASCADE and foreign keys
// are on above.
const userFoodIds = db
  .prepare("SELECT id FROM foods WHERE source IN ('custom', 'recipe', 'recipe_log')")
  .all()
  .map((r) => r.id)
const delFts = db.prepare('DELETE FROM foods_fts WHERE rowid = ?')
for (const id of userFoodIds) delFts.run(id)

db.exec("DELETE FROM foods WHERE source IN ('custom', 'recipe', 'recipe_log')")
db.exec('DELETE FROM water_entries')
db.exec('DELETE FROM workout_entries')
db.exec('DELETE FROM weight_entries')
// These would cascade from `users`, but only while foreign keys are enforced.
// Personal data is not something to leave depending on a PRAGMA.
db.exec('DELETE FROM biometric_entries')
db.exec('DELETE FROM biometric_types')
db.exec('DELETE FROM exercises WHERE owner_user_id IS NOT NULL')

// Who knows whom, and every live invite or share link. Same reasoning as
// above, plus these are the rows that would let a stranger holding an old link
// walk into a handed-over database. Skipped when the table isn't there yet, so
// this still runs against a database from before friends existed.
for (const table of ['recipe_shares', 'friend_invites', 'friendships']) {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  if (exists) db.exec(`DELETE FROM ${table}`)
}

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
    `${userFoodIds.length} custom foods and recipes. ` +
    `${before.foods - userFoodIds.length} foods kept.`,
)
db.close()

#!/usr/bin/env node
/**
 * Freeze diary entries that were logged before recipes were frozen.
 *
 * A meal logged today points at a `recipe_log` copy of the recipe, so editing
 * the recipe afterwards can't move it. Meals logged *before* that change point
 * straight at the recipe and still drift. This gives each of them a frozen copy
 * of the recipe **as it stands right now**, which is the honest limit of what
 * can be done: it cannot recover what the recipe looked like last February,
 * only stop it moving from here.
 *
 *   node scripts/snapshot-diary-recipes.mjs [db-path]            # dry run
 *   node scripts/snapshot-diary-recipes.mjs [db-path] --commit   # for real
 *
 * The dry run is not a simulation: it does the entire migration inside a
 * transaction, checks it, and rolls back. What it prints is what --commit does.
 *
 * Copy the database first. This rewrites `diary_entries.food_id`, and while it
 * is designed to be a no-op arithmetically, "designed to be" is not "was".
 */
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { RECIPE_SOURCE } from '#shared/recipes'
import { ensureSchema } from '../server/utils/db.ts'
import { snapshotRecipeForLog } from '../server/utils/recipes.ts'

const args = process.argv.slice(2)
const commit = args.includes('--commit')
const dbFile = resolve(args.find((a) => !a.startsWith('--')) || process.env.FITTOWN_DB_PATH || 'data/fittown.db')

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 15000')

console.log(`Database: ${dbFile}`)

// Refuses a database it can't read cleanly. This file has been corrupt once
// before (AGENTS.md §1), and a migration is the last thing that should be the
// first to notice.
const { quick_check: health } = db.prepare('PRAGMA quick_check').get()
if (health !== 'ok') {
  console.error(`\nRefusing to run: quick_check says "${health}".`)
  process.exit(1)
}

// The app applies pending column additions lazily, on its first request. A
// database that has not been served since this feature shipped therefore has no
// `logged_from_food_id` yet, and reading one would fail halfway through with a
// bare "no such column". Migrate first — it is the same code path the app uses,
// idempotent, and a no-op on a database that is already current.
//
// Before enabling foreign keys, because part of the migration rebuilds a table.
const added = ensureSchema(db)
db.exec('PRAGMA foreign_keys = ON')
if (added.size > 0) {
  console.log(`Schema brought up to date: added ${[...added].join(', ')}`)
}

const counts = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM foods)         AS foods,
       (SELECT COUNT(*) FROM users)         AS users,
       (SELECT COUNT(*) FROM diary_entries) AS entries`,
  )
  .get()
console.log(
  `quick_check ok · ${counts.foods} foods · ${counts.users} users · ${counts.entries} diary entries`,
)

/** Entries still pointing straight at a recipe. Already-frozen ones aren't. */
const pending = db
  .prepare(
    `SELECT d.id, d.user_id, d.date, d.meal, d.food_id, d.grams, f.name
     FROM diary_entries d
     JOIN foods f ON f.id = d.food_id
     WHERE f.source = ?
     ORDER BY d.date, d.id`,
  )
  .all(RECIPE_SOURCE)

if (pending.length === 0) {
  console.log('\nNothing to do — every logged recipe already has its own frozen copy.')
  db.close()
  process.exit(0)
}

/** What each person's day comes to, by the same arithmetic the trends use. */
const dayTotals = () =>
  new Map(
    db
      .prepare(
        `SELECT d.user_id, d.date, SUM(f.kcal * d.grams / 100.0) AS kcal
         FROM diary_entries d
         JOIN foods f ON f.id = d.food_id
         GROUP BY d.user_id, d.date`,
      )
      .all()
      .map((row) => [`${row.user_id}:${row.date}`, row.kcal ?? 0]),
  )

console.log(`\n${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} to freeze:\n`)
for (const entry of pending) {
  console.log(
    `  ${entry.date}  ${entry.meal.padEnd(9)} ${String(entry.name).slice(0, 40).padEnd(42)}`
    + `${Math.round(entry.grams)} g`,
  )
}

const before = dayTotals()

db.exec('BEGIN')
try {
  const repoint = db.prepare('UPDATE diary_entries SET food_id = ? WHERE id = ?')
  for (const entry of pending) {
    const { id } = snapshotRecipeForLog(db, entry.food_id, entry.user_id)
    repoint.run(id, entry.id)
  }

  // Repointing at a frozen copy of the same recipe must change nothing. If a
  // day moves, the recipe's stored nutrition disagreed with its own
  // ingredients — run scripts/recompute-recipes.mjs and try again rather than
  // quietly restating somebody's history.
  const after = dayTotals()
  const moved = []
  for (const [key, kcal] of before) {
    const now = after.get(key) ?? 0
    if (Math.abs(now - kcal) > 0.01) moved.push({ key, kcal, now })
  }

  if (moved.length > 0) {
    for (const m of moved) {
      console.error(`  ${m.key}: ${m.kcal.toFixed(1)} kcal became ${m.now.toFixed(1)}`)
    }
    throw new Error(`${moved.length} day(s) changed — rolled back`)
  }

  if (commit) {
    db.exec('COMMIT')
    console.log(`\nFroze ${pending.length} entr${pending.length === 1 ? 'y' : 'ies'}. No day's total moved.`)
  } else {
    db.exec('ROLLBACK')
    console.log(
      `\nDry run: ${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} would be frozen, `
      + 'and no day\'s total moved. Nothing was written.'
      + '\nRe-run with --commit to keep it.',
    )
  }
} catch (err) {
  db.exec('ROLLBACK')
  console.error(`\nFailed: ${err.message}`)
  db.close()
  process.exit(1)
}

db.close()

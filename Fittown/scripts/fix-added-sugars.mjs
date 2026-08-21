#!/usr/bin/env node
/**
 * Fix `added_sugars_g` for pure added sugars in an existing database.
 *
 * The importers gain a "pure sugar ⇒ added sugars" fallback the next time they
 * run, but that doesn't help a database that's already been imported. This
 * script catches up the current rows: any pure added sugar (a product that IS
 * sugar — cane, brown, powdered, icing, turbinado, demerara, sucanat, palm,
 * coconut/maple sugar, sugar cubes, ...) whose added-sugars is missing, 0, or
 * clearly understated gets it set to its total sugars, which for these
 * products ARE their added sugars.
 *
 * Uses the same `isPureAddedSugar()` rule the importers do, always combined
 * with a high total-sugars floor, so multi-component foods (candy, gum,
 * wafers, hot-cocoa mix, glazes, fruit-and-sugar preserves) are never caught.
 * Zero-/no-calorie sweeteners (stevia, monk fruit, erythritol, Splenda, ...)
 * and single-ingredient syrups (honey, maple syrup, molasses, agave) are
 * excluded by the rule.
 *
 *   node scripts/fix-added-sugars.mjs [db-path]        # write
 *   node scripts/fix-added-sugars.mjs [db-path] --dry  # report only
 *
 * Also respects FITTOWN_DB_PATH. Defaults to `data/fittown.db` like the other
 * scripts.
 */
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { ensureSchema } from '../server/utils/db.ts'
import { isPureAddedSugar, PURE_SUGAR_MIN_SUGARS } from './lib/pureSugar.mjs'

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const dryRun = process.argv.includes('--dry')
const dbFile = resolve(positional[0] || process.env.FITTOWN_DB_PATH || 'data/fittown.db')

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 15000')

// The app adds new columns lazily (on first request), so a DB that hasn't been
// served since a release is missing later columns — and this SELECT would
// otherwise die with "no such column". Same catch-up the app runs; also
// rebuilds the table before foreign keys go on.
ensureSchema(db)
db.exec('PRAGMA foreign_keys = ON')

// added_sugars_g IS NULL, treated as 0 (the raw 0 the OFF/USDA data carries
// for pure sugars), or stated below 90% of total sugars (a clear understatement
// for a product that is essentially all sugar) — in all three cases it should
// equal total sugars.
const rows = db
  .prepare(
    `SELECT id, name, categories, sugars_g, added_sugars_g
     FROM foods WHERE sugars_g >= ?`,
  )
  .all(PURE_SUGAR_MIN_SUGARS)

const changed = []
for (const r of rows) {
  if (typeof r.sugars_g !== 'number' || r.sugars_g < PURE_SUGAR_MIN_SUGARS) continue
  if (!isPureAddedSugar(r.categories, r.name)) continue
  const added = typeof r.added_sugars_g === 'number' ? r.added_sugars_g : null
  if (added !== null && added >= r.sugars_g * 0.9) continue // already right
  changed.push({ id: r.id, name: r.name, sugars: r.sugars_g, added })
}

console.log(
  `${changed.length} pure-added-sugar row(s) need fixing (${dryRun ? 'dry run — no changes' : 'will write'}).`,
)

if (dryRun) {
  for (const c of changed) {
    console.log(`  [${c.id}] ${c.name} — sugars ${c.sugars} g, added_sugars ${c.added ?? 'NULL'} -> ${c.sugars}`)
  }
  db.close()
  process.exit(0)
}

db.exec('BEGIN')
try {
  const stmt = db.prepare('UPDATE foods SET added_sugars_g = ? WHERE id = ?')
  for (const c of changed) stmt.run(c.sugars, c.id)
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  throw err
}

console.log(`Updated ${changed.length} row(s).`)
for (const c of changed.slice(0, 25)) {
  console.log(`  [${c.id}] ${c.name} — added_sugars ${c.added ?? 'NULL'} -> ${c.sugars} g`)
}
if (changed.length > 25) console.log(`  …and ${changed.length - 25} more.`)
db.close()

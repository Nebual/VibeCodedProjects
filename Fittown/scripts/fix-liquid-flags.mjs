#!/usr/bin/env node
/**
 * Recompute `foods.is_liquid` in place using the importer's current rule.
 *
 * Saves a full re-import when only the classification heuristic changed.
 */
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { isLiquid } from './lib/liquid.mjs'

const dbFile = resolve(
  process.argv[2] || process.env.FITTOWN_DB_PATH || 'data/fittown.db',
)
const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 15000')

const before = db.prepare('SELECT COALESCE(SUM(is_liquid),0) n FROM foods').get().n
const rows = db.prepare('SELECT id, name, categories, is_liquid FROM foods').all()
const update = db.prepare('UPDATE foods SET is_liquid = ? WHERE id = ?')

db.exec('BEGIN')
let changed = 0
for (const row of rows) {
  const value = isLiquid(row.categories, row.name)
  if (value !== row.is_liquid) {
    update.run(value, row.id)
    changed++
  }
}
db.exec('COMMIT')

const after = db.prepare('SELECT COALESCE(SUM(is_liquid),0) n FROM foods').get().n
console.log(`is_liquid: ${before} -> ${after} (${changed} rows changed)`)

for (const probe of ['Greek yogurt', 'Sparkling Water']) {
  const r = db
    .prepare('SELECT name, is_liquid, categories FROM foods WHERE name LIKE ? LIMIT 1')
    .get(`%${probe}%`)
  if (r) console.log(`  ${r.is_liquid ? 'liquid' : 'solid '}  ${r.name}`)
}

db.close()

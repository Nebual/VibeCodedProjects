#!/usr/bin/env node
/**
 * Re-roll every recipe from its ingredients.
 *
 * A recipe's nutrient columns are a cached sum of the foods underneath it, so
 * anything that changes those foods — most obviously a re-import of Open Food
 * Facts, which refreshes 200k rows in place — leaves recipes quietly stale.
 * `import-off.mjs` calls this at the end for exactly that reason; run it by
 * hand after any other bulk edit to `foods`.
 *
 *   node scripts/recompute-recipes.mjs [db-path]
 *
 * The recompute itself is imported from the app rather than reimplemented here:
 * two copies of this arithmetic would eventually disagree, and the one that was
 * wrong would be the one nobody was looking at.
 */
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { ensureSchema } from '../server/utils/db.ts'
import { recipesInDependencyOrder, recomputeRecipe } from '../server/utils/recipes.ts'

const dbFile = resolve(process.argv[2] || process.env.FITTOWN_DB_PATH || 'data/fittown.db')

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 15000')

// The app adds new columns lazily, on its first request, so a database that
// hasn't been served since a schema change lacks them — and every query built
// from `foodCols()` would fail with a bare "no such column". Same code path the
// app uses, idempotent, and necessarily before foreign keys go on (part of it
// rebuilds a table).
ensureSchema(db)
db.exec('PRAGMA foreign_keys = ON')

// Children before parents: a recipe can hold another recipe, and rolling a
// salad up before its dressing would cache the dressing's stale numbers.
// Frozen meals (source = 'recipe_log') are deliberately not in this list —
// re-rolling one would rewrite a meal somebody already ate.
const recipes = recipesInDependencyOrder(db)

if (recipes.length === 0) {
  console.log('No recipes to recompute.')
  db.close()
  process.exit(0)
}

let changed = 0
db.exec('BEGIN')
try {
  for (const recipe of recipes) {
    const before = db.prepare('SELECT kcal, serving_grams FROM foods WHERE id = ?').get(recipe.id)
    recomputeRecipe(db, recipe.id)
    const after = db.prepare('SELECT kcal, serving_grams FROM foods WHERE id = ?').get(recipe.id)
    if (before.kcal !== after.kcal || before.serving_grams !== after.serving_grams) {
      changed++
      console.log(`  updated: ${recipe.name}`)
    }
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  throw err
}

console.log(
  `Recomputed ${recipes.length} recipe${recipes.length === 1 ? '' : 's'}; ${changed} changed.`,
)
db.close()

#!/usr/bin/env node
/**
 * Import a small multi-chain fast-food nutrition dataset (TidyTuesday's
 * `fastfood_calories.csv`) into Fittown's SQLite database.
 *
 * Covers 7 US chains: Chick-fil-A, Sonic, Arby's, Burger King, Dairy Queen,
 * Subway, Taco Bell — ~460 entrees/sides/salads (of ~515 total rows; the
 * McDonald's rows are skipped, see below). No beverages (verified against
 * the real file: nothing in it matches a drink keyword).
 *
 * McDonald's is deliberately excluded from this import: import-mcdonalds-
 * menu.mjs covers it from a separate, far more complete McDonald's-specific
 * file (260 items across every category, including breakfast and drinks,
 * with a real per-item weight for each) — see that file's header. Keeping
 * both would just duplicate every McDonald's item at two different quality
 * levels.
 *
 * Known limitations, accepted deliberately rather than blocking the import:
 *
 *  - No Wendy's, no Domino's. Neither appears in this dataset at all, and no
 *    free bulk dataset covering them was found. Domino's especially doesn't
 *    fit this "one row per item" shape anyway (size x crust x topping
 *    combinatorics).
 *
 *  - The data is from 2018 and won't reflect menu/recipe changes since.
 *
 *  - No per-item weight in grams anywhere in the source. Every row reports
 *    nutrition for one whole menu item (e.g. one Big Mac), not per 100 g,
 *    and the `foods` table only ever stores per-100g/ml. Rather than invent
 *    a real gram weight, this treats the reported serving as a synthetic
 *    100-unit basis: the raw per-item numbers go straight into the per-100g
 *    columns, and `serving_grams` / the food_servings row are set to 100 so
 *    that picking "1 serving" in the portion picker reproduces the correct
 *    totals exactly. Logging this food by an actually-weighed gram amount
 *    will NOT be accurate — there is nothing here to normalize against, so
 *    100 is a bookkeeping convention, not a real weight.
 *
 *  - vit_a/vit_c/calcium are %daily-value in the source (not absolute
 *    amounts), and it isn't clear which FDA label revision (pre/post the
 *    2016 DV change) each chain used when their page was scraped — left
 *    null rather than risk a confidently-wrong number.
 *
 * Usage:
 *   node scripts/import-fastfood-tidytuesday.mjs
 *   node scripts/import-fastfood-tidytuesday.mjs --url=<csv url>
 *   node scripts/import-fastfood-tidytuesday.mjs --file=<local csv>
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseCsvRecords } from './lib/csv.mjs'

const DEFAULT_URL =
  'https://raw.githubusercontent.com/rfordatascience/tidytuesday/master/data/2018/2018-09-04/fastfood_calories.csv'

const SOURCE = 'fastfood-tidytuesday'

/** Not a real gram weight — see the file header. Just what "1 serving" means for this data. */
const SYNTHETIC_SERVING_GRAMS = 100

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)

const dbFile = resolve(args.db || process.env.FITTOWN_DB_PATH || 'data/fittown.db')

/** The source CSV's brand spellings are missing apostrophes/hyphens ("Mcdonalds", "Arbys"). */
const RESTAURANT_BRAND = {
  Mcdonalds: "McDonald's",
  'Chick Fil-A': 'Chick-fil-A',
  Sonic: 'Sonic',
  Arbys: "Arby's",
  'Burger King': 'Burger King',
  'Dairy Queen': 'Dairy Queen',
  Subway: 'Subway',
  'Taco Bell': 'Taco Bell',
}

function num(cell) {
  if (cell === undefined || cell === '') return null
  const n = Number(cell)
  return Number.isFinite(n) ? n : null
}

/**
 * These caps are just a parse-error guard, not a per-100g physical
 * plausibility ceiling like the other importers use — that ceiling doesn't
 * apply here, since these numbers describe a whole meal item, not a
 * nutrient density (see SYNTHETIC_SERVING_GRAMS above). Set generously above
 * the real observed max in this file (2,430 kcal, 6,080 mg sodium).
 */
function sane(value, max) {
  if (value === null) return null
  if (!Number.isFinite(value) || value < 0 || value > max) return null
  return value
}

/** Salt isn't reported separately; the standard label-math approximation the other importers use. */
const SODIUM_TO_SALT = 2.5 / 1000

function slugBarcode(restaurant, item) {
  const slug = `${restaurant} ${item}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `tidytuesday-${slug}`.slice(0, 150)
}

async function readCsv() {
  if (args.file) return parseCsvRecords(readFileSync(resolve(args.file), 'utf8'))
  const url = args.url || DEFAULT_URL
  console.log(`Downloading ${url}`)
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Fittown/0.1 (personal family nutrition tracker)' },
  })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  return parseCsvRecords(await res.text())
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const rows = await readCsv()
console.log(`${rows.length} rows read`)

mkdirSync(dirname(dbFile), { recursive: true })
const db = new DatabaseSync(dbFile)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 30000')

const { ensureSchema } = await import('../server/utils/db.ts').catch(() => ({}))
if (ensureSchema) {
  ensureSchema(db)
} else {
  const hasFoods = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foods'")
    .get()
  if (!hasFoods) {
    console.error('No `foods` table found. Start the app once to create the schema, then re-run.')
    process.exit(1)
  }
}

const INSERT_COLS = [
  'source', 'barcode', 'name', 'brand', 'categories', 'is_liquid',
  'serving_size_text', 'serving_grams',
  'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugars_g',
  'sat_fat_g', 'trans_fat_g', 'cholesterol_mg', 'sodium_mg', 'salt_g',
]
const placeholders = INSERT_COLS.map(() => '?').join(', ')
const updates = INSERT_COLS.filter((c) => c !== 'source' && c !== 'barcode')
  .map((c) => `${c} = excluded.${c}`)
  .join(', ')

const upsert = db.prepare(`
  INSERT INTO foods (${INSERT_COLS.join(', ')})
  VALUES (${placeholders})
  ON CONFLICT(source, barcode) DO UPDATE SET ${updates}
`)
// node:sqlite's lastInsertRowid is only meaningful when the upsert actually
// inserted a row — on the ON CONFLICT DO UPDATE path (any re-run, since
// every row already exists after the first) SQLite leaves it unchanged from
// whatever the previous statement was, silently pointing food_servings at
// the wrong food. A lookup by the same (source, barcode) key is correct
// either way.
const selectFoodId = db.prepare('SELECT id FROM foods WHERE source = ? AND barcode = ?')
const deleteServings = db.prepare('DELETE FROM food_servings WHERE food_id = ?')
const insertServing = db.prepare(
  'INSERT INTO food_servings (food_id, label, grams, is_default) VALUES (?, ?, ?, ?)',
)
let imported = 0
let skippedNoNutrition = 0
let skippedNoName = 0
let skippedMcdonalds = 0

db.exec('BEGIN')
for (const row of rows) {
  const restaurant = row.restaurant?.trim()
  const item = row.item?.trim()
  if (!restaurant || !item) {
    skippedNoName++
    continue
  }

  // Handled by import-mcdonalds-menu.mjs instead — see the file header.
  if (restaurant === 'Mcdonalds') {
    skippedMcdonalds++
    continue
  }

  const kcal = sane(num(row.calories), 5_000)
  const protein = sane(num(row.protein), 500)
  const carbs = sane(num(row.total_carb), 500)
  const fat = sane(num(row.total_fat), 500)

  // Same bar as the other importers: a diary entry is only useful with
  // either a stated energy value or a full macro breakdown.
  if (kcal === null && (protein === null || carbs === null || fat === null)) {
    skippedNoNutrition++
    continue
  }

  const sodium = sane(num(row.sodium), 20_000)
  const brand = RESTAURANT_BRAND[restaurant] ?? restaurant
  const name = item.slice(0, 200)
  const barcode = slugBarcode(restaurant, item)

  const values = [
    SOURCE,
    barcode,
    name,
    brand.slice(0, 120),
    'Fast food',
    // Confirmed against the real file: this dataset is entrees/sides/
    // salads only, no beverages.
    0,
    '1 serving',
    SYNTHETIC_SERVING_GRAMS,
    kcal,
    protein,
    carbs,
    fat,
    sane(num(row.fiber), 500),
    sane(num(row.sugar), 500),
    sane(num(row.sat_fat), 500),
    sane(num(row.trans_fat), 500),
    sane(num(row.cholesterol), 20_000),
    sodium,
    sodium === null ? null : sane(sodium * SODIUM_TO_SALT, 50),
  ]

  upsert.run(...values)
  const { id: foodId } = selectFoodId.get(SOURCE, barcode)

  deleteServings.run(foodId)
  insertServing.run(foodId, '1 serving', SYNTHETIC_SERVING_GRAMS, 1)

  imported++
}
db.exec('COMMIT')

// A full rebuild (rather than per-row foods_fts upkeep) sidesteps a real
// footgun with external-content FTS5 tables: removing a stale entry on an
// UPDATE requires the *old* name/brand, which is no longer recoverable once
// the upsert above has already overwritten it — see reindexFood() in
// server/utils/recipes.ts. A wholesale rebuild is what the other bulk
// importers already do for the same reason.
console.log('Rebuilding full-text search index...')
db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')")

console.log('Optimising database...')
db.exec('PRAGMA optimize')
db.exec('ANALYZE')

const { total } = db.prepare('SELECT COUNT(*) AS total FROM foods WHERE source = ?').get(SOURCE)

console.log(`
Import complete
  rows read:                 ${rows.length}
  imported:                  ${imported}
  skipped (no name):         ${skippedNoName}
  skipped (no nutrition):    ${skippedNoNutrition}
  skipped (mcdonalds):       ${skippedMcdonalds}
  fastfood rows in database: ${total}
`)

db.close()

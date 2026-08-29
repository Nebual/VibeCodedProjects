#!/usr/bin/env node
/**
 * Import McDonald's full menu nutrition data from a locally-provided CSV
 * (scripts/csvs/mcdonald_menu.csv) into Fittown's SQLite database.
 *
 * This is a ~3-year-old McDonald's-specific nutrition export, added to the
 * repo directly rather than fetched — 260 items across every menu category
 * (breakfast, burgers, chicken/fish, salads, sides, desserts, beverages,
 * coffee/tea, smoothies/shakes/McFlurries). That's far more complete for
 * McDonald's than TidyTuesday's bulk CSV (57 entree-only rows — no
 * breakfast, no drinks at all), so import-fastfood-tidytuesday.mjs now skips
 * McDonald's entirely in favour of this file (see the comment there). This
 * script also deletes any already-imported 'fastfood-tidytuesday' rows
 * branded McDonald's from an earlier run, so re-running the full pipeline in
 * any order converges on the same state rather than leaving two overlapping,
 * differently-normalized copies of the same items in search results.
 *
 * Unlike the TidyTuesday import, this file states a real per-item weight for
 * every row (verified against the full file: every "Serving Size" cell
 * matches one of two shapes), so every row here gets a genuine per-100g/ml
 * conversion rather than TidyTuesday's synthetic-100-unit placeholder:
 *  - most food items: "<oz> (<n> g)", e.g. "4.8 oz (136 g)" — the
 *    parenthetical is the real weight.
 *  - most plain beverages (soda, coffee, tea, smoothies, shakes — sold and
 *    labelled by volume, not weight): just "<n> fl oz cup", with no
 *    parenthetical at all. Converted to mL via the exact 29.5735295 mL per
 *    US fl oz constant (a unit conversion, not an estimate).
 *
 * Vitamin A/C, calcium and iron are %daily-value only in this file too (same
 * as TidyTuesday), and dropped for the same reason: it's unclear which FDA
 * label revision is behind any given item's %DV, so there's no reliably
 * correct way to turn a %DV back into an absolute amount.
 *
 * Usage:
 *   node scripts/import-mcdonalds-menu.mjs
 *   node scripts/import-mcdonalds-menu.mjs --file=<path to a newer csv>
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseCsvRecords } from './lib/csv.mjs'

const SOURCE = 'fastfood-mcdonalds-menu'
const BRAND = "McDonald's"

/** The row set this file replaces — see the file header. */
const SUPERSEDED_SOURCE = 'fastfood-tidytuesday'

const DEFAULT_FILE = 'scripts/csvs/mcdonald_menu.csv'

/** An exact unit conversion, not an estimate — used only when the CSV gives no gram/ml weight directly. */
const ML_PER_FL_OZ = 29.5735295

/** Everything else (breakfast, burgers, sides, desserts, McFlurries) is solid/semi-solid and weighed in grams in this file. */
const LIQUID_CATEGORIES = new Set(['Beverages', 'Coffee & Tea', 'Smoothies & Shakes'])

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
const csvFile = resolve(args.file || DEFAULT_FILE)

function num(cell) {
  if (cell === undefined || cell === '') return null
  const n = Number(cell)
  return Number.isFinite(n) ? n : null
}

/**
 * Same per-100g physical plausibility ceilings the USDA importers use —
 * unlike TidyTuesday's importer, every row here really does get normalized
 * against a real weight (verified: no row falls back to the synthetic
 * basis), so a physical ceiling is meaningful here rather than a bare
 * parse-error guard.
 */
function sane(value, max) {
  if (value === null) return null
  if (!Number.isFinite(value) || value < 0 || value > max) return null
  return value
}

const SODIUM_TO_SALT = 2.5 / 1000

/**
 * Real weight in g/ml when the CSV states one directly ("4.8 oz (136 g)",
 * "1 carton (236 ml)"); otherwise convert a bare fl-oz volume ("16 fl oz
 * cup") via the exact mL-per-fl-oz constant. Verified against every row in
 * the real file: every Serving Size matches one of these two shapes, so the
 * null fallback below is defensive only and shouldn't ever fire.
 */
function parseServingBasis(servingSize) {
  const paren = servingSize.match(/\(([\d.]+)\s*(?:g|ml)\)/)
  if (paren) return Number(paren[1])

  const flOz = servingSize.match(/^([\d.]+)\s*fl\s*oz/i)
  if (flOz) return Number(flOz[1]) * ML_PER_FL_OZ

  return null
}

function slugBarcode(item) {
  const slug = item
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `mcdonalds-menu-${slug}`.slice(0, 150)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const rows = parseCsvRecords(readFileSync(csvFile, 'utf8'))
console.log(`${rows.length} rows read from ${csvFile}`)

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
// inserted a row — on a re-run's ON CONFLICT DO UPDATE path it's left
// unchanged from whatever the previous statement was, silently pointing
// food_servings at the wrong food. A lookup by (source, barcode) is correct
// either way.
const selectFoodId = db.prepare('SELECT id FROM foods WHERE source = ? AND barcode = ?')
const deleteServings = db.prepare('DELETE FROM food_servings WHERE food_id = ?')
const insertServing = db.prepare(
  'INSERT INTO food_servings (food_id, label, grams, is_default) VALUES (?, ?, ?, ?)',
)

// This file covers every category TidyTuesday's didn't (breakfast, drinks)
// and reports real per-item weights where TidyTuesday had none, so keeping
// both would just duplicate every item at two different quality levels.
// `food_servings` cascades on delete; `foods_fts` is rebuilt wholesale below
// regardless of what changed above it.
const superseded = db
  .prepare('DELETE FROM foods WHERE source = ? AND brand = ?')
  .run(SUPERSEDED_SOURCE, BRAND)
console.log(`Removed ${superseded.changes} superseded ${SUPERSEDED_SOURCE} McDonald's row(s)`)

let imported = 0
let skipped = 0

db.exec('BEGIN')
for (const row of rows) {
  const item = row.Item?.trim()
  const category = row.Category?.trim()
  if (!item) {
    skipped++
    continue
  }

  const rawKcal = num(row.Calories)
  const rawProtein = num(row.Protein)
  const rawCarbs = num(row.Carbohydrates)
  const rawFat = num(row['Total Fat'])

  // Same bar as the other importers: a diary entry is only useful with
  // either a stated energy value or a full macro breakdown.
  if (rawKcal === null && (rawProtein === null || rawCarbs === null || rawFat === null)) {
    skipped++
    continue
  }

  const basisAmount = parseServingBasis(row['Serving Size']) ?? 100
  const factor = 100 / basisAmount
  const scale = (raw, max) => (raw === null ? null : sane(raw * factor, max))

  const sodium = scale(num(row.Sodium), 40_000)
  const servingText = row['Serving Size']?.trim() || null
  const name = item.slice(0, 200)
  const barcode = slugBarcode(item)

  const values = [
    SOURCE,
    barcode,
    name,
    BRAND,
    category || null,
    LIQUID_CATEGORIES.has(category) ? 1 : 0,
    servingText,
    basisAmount,
    scale(rawKcal, 900),
    scale(rawProtein, 100),
    scale(rawCarbs, 100),
    scale(rawFat, 100),
    scale(num(row['Dietary Fiber']), 100),
    scale(num(row.Sugars), 100),
    scale(num(row['Saturated Fat']), 100),
    scale(num(row['Trans Fat']), 100),
    scale(num(row.Cholesterol), 5_000),
    sodium,
    sodium === null ? null : sane(sodium * SODIUM_TO_SALT, 100),
  ]

  upsert.run(...values)
  const { id: foodId } = selectFoodId.get(SOURCE, barcode)

  deleteServings.run(foodId)
  insertServing.run(foodId, servingText ?? '1 serving', basisAmount, 1)

  imported++
}
db.exec('COMMIT')

console.log('Rebuilding full-text search index...')
db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')")

console.log('Optimising database...')
db.exec('PRAGMA optimize')
db.exec('ANALYZE')

const { total } = db.prepare('SELECT COUNT(*) AS total FROM foods WHERE source = ?').get(SOURCE)

console.log(`
Import complete
  rows read:                            ${rows.length}
  imported:                             ${imported}
  skipped:                              ${skipped}
  superseded tidytuesday rows removed:  ${superseded.changes}
  ${SOURCE} rows in database: ${total}
`)

db.close()

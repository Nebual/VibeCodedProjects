#!/usr/bin/env node
/**
 * Import Open Food Facts into Fittown's SQLite database.
 *
 * Streams the gzipped CSV export straight from OFF, decompressing and
 * filtering on the fly so the ~10 GB raw CSV never touches disk — only the
 * rows we keep are ever materialised.
 *
 * Rows are upserted on (source, barcode) so food ids stay stable across
 * re-imports; refreshing the dataset never re-points existing diary entries
 * at a different product.
 *
 * Usage:
 *   node scripts/import-off.mjs                     # US + Canada (default)
 *   node scripts/import-off.mjs --countries=all     # no country filter
 *   node scripts/import-off.mjs --file=dump.csv.gz  # use a local dump
 *   node scripts/import-off.mjs --limit=50000       # stop early (testing)
 */
import { DatabaseSync } from 'node:sqlite'
import { createGunzip } from 'node:zlib'
import { createReadStream, mkdirSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { isLiquid } from './lib/liquid.mjs'

const DUMP_URL =
  'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz'

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)

const dbFile = resolve(
  args.db || process.env.FITTOWN_DB_PATH || 'data/fittown.db',
)
const limit = args.limit ? Number(args.limit) : Infinity
const countriesArg = (args.countries || 'us,ca').toLowerCase()

/** Match against OFF's comma-separated `countries_en` column. */
const COUNTRY_PATTERNS = {
  us: /united states/i,
  ca: /canada/i,
  uk: /united kingdom/i,
  au: /australia/i,
}
const countryFilter =
  countriesArg === 'all'
    ? null
    : countriesArg
        .split(',')
        .map((c) => COUNTRY_PATTERNS[c.trim()])
        .filter(Boolean)

// ---------------------------------------------------------------------------
// Column mapping
//
// OFF normalises every `*_100g` nutrient to GRAMS per 100 g of product
// (energy is the exception, carried separately in kcal and kJ). So a vitamin C
// value of 0.0532 means 53.2 mg. `scale` converts grams into the unit our
// schema stores for that column.
// ---------------------------------------------------------------------------

const MG = 1e3 // grams -> milligrams
const UG = 1e6 // grams -> micrograms

/**
 * dbColumn -> [offColumn, scale, maxPer100g]
 *
 * `max` is a plausibility ceiling expressed in the DB column's own unit, set
 * a little above the richest real food so genuine extremes survive:
 * pure salt really is ~38,800 mg sodium/100 g, brazil nuts ~1,900 µg selenium,
 * acerola ~1,700 mg vitamin C, beef liver ~30,000 µg vitamin A.
 *
 * This matters because OFF is crowd-sourced and riddled with unit-entry
 * mistakes. A blanket "100 g per 100 g" check passes a value of 9.4 that then
 * becomes 9,375,000 µg of vitamin D — enough to wreck a day's totals.
 */
const NUTRIENTS = {
  protein_g: ['proteins_100g', 1, 100],
  carbs_g: ['carbohydrates_100g', 1, 100],
  fat_g: ['fat_100g', 1, 100],
  fiber_g: ['fiber_100g', 1, 100],
  sugars_g: ['sugars_100g', 1, 100],
  added_sugars_g: ['added-sugars_100g', 1, 100],
  sugar_alcohols_g: ['polyols_100g', 1, 100],
  sat_fat_g: ['saturated-fat_100g', 1, 100],
  trans_fat_g: ['trans-fat_100g', 1, 100],
  mono_fat_g: ['monounsaturated-fat_100g', 1, 100],
  poly_fat_g: ['polyunsaturated-fat_100g', 1, 100],
  omega3_g: ['omega-3-fat_100g', 1, 100],
  alcohol_g: ['alcohol_100g', 1, 100],
  water_g: ['water_100g', 1, 100],
  salt_g: ['salt_100g', 1, 100],

  cholesterol_mg: ['cholesterol_100g', MG, 5_000],
  sodium_mg: ['sodium_100g', MG, 40_000],
  caffeine_mg: ['caffeine_100g', MG, 10_000],
  potassium_mg: ['potassium_100g', MG, 6_000],
  calcium_mg: ['calcium_100g', MG, 5_000],
  iron_mg: ['iron_100g', MG, 500],
  magnesium_mg: ['magnesium_100g', MG, 2_000],
  zinc_mg: ['zinc_100g', MG, 500],
  phosphorus_mg: ['phosphorus_100g', MG, 3_000],
  copper_mg: ['copper_100g', MG, 50],
  manganese_mg: ['manganese_100g', MG, 100],
  vit_c_mg: ['vitamin-c_100g', MG, 5_000],
  vit_e_mg: ['vitamin-e_100g', MG, 1_000],
  vit_b1_mg: ['vitamin-b1_100g', MG, 200],
  vit_b2_mg: ['vitamin-b2_100g', MG, 200],
  vit_b3_mg: ['vitamin-pp_100g', MG, 500],
  vit_b6_mg: ['vitamin-b6_100g', MG, 200],

  selenium_ug: ['selenium_100g', UG, 10_000],
  iodine_ug: ['iodine_100g', UG, 100_000],
  vit_a_ug: ['vitamin-a_100g', UG, 100_000],
  vit_d_ug: ['vitamin-d_100g', UG, 1_000],
  vit_k_ug: ['vitamin-k_100g', UG, 5_000],
  folate_ug: ['vitamin-b9_100g', UG, 10_000],
  vit_b12_ug: ['vitamin-b12_100g', UG, 1_000],
}

const NUTRIENT_COLS = Object.keys(NUTRIENTS)

const INSERT_COLS = [
  'source', 'barcode', 'name', 'brand', 'quantity', 'categories', 'image_url',
  'serving_size_text', 'serving_grams', 'is_liquid', 'kcal',
  ...NUTRIENT_COLS,
  'nutriscore', 'nova_group', 'popularity',
]

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse a numeric cell, rejecting blanks and non-finite junk. */
function num(cell) {
  if (cell === undefined || cell === '') return null
  const n = Number(cell)
  return Number.isFinite(n) ? n : null
}

/**
 * Clamp a nutrient to a physically possible range.
 *
 * OFF is crowd-sourced and contains unit-entry mistakes (sodium typed in mg
 * into a gram field, etc.). Anything beyond 100 g per 100 g of product is
 * impossible, so drop it rather than let it poison a day's totals.
 */
function sane(value, max) {
  if (value === null) return null
  if (value < 0 || value > max) return null
  return value
}

/** Energy density of pure fat, the most calorific thing a food can be. */
const MAX_KCAL_PER_100G = 900

/**
 * Resolve kcal per 100 g.
 *
 * Prefers the stated value but cross-checks it against the Atwater estimate
 * from the macros, because a very common OFF entry error is kJ typed into the
 * kcal field (inflating by ~4.2x). When the two disagree wildly the macros are
 * the more trustworthy source, since they're what labels state most reliably.
 */
function resolveKcal(get, macros) {
  const stated =
    sane(num(get('energy-kcal_100g')), MAX_KCAL_PER_100G) ??
    (() => {
      const kj = num(get('energy_100g'))
      return kj === null ? null : sane(kj / 4.184, MAX_KCAL_PER_100G)
    })()

  const { protein, carbs, fat } = macros
  const atwater =
    protein !== null && carbs !== null && fat !== null
      ? protein * 4 + carbs * 4 + fat * 9
      : null

  if (stated === null) return atwater === null ? null : sane(atwater, MAX_KCAL_PER_100G)
  if (atwater === null || atwater < 20) return stated

  const ratio = stated / atwater
  return ratio > 2 || ratio < 0.5 ? sane(atwater, MAX_KCAL_PER_100G) : stated
}

function cleanText(s) {
  if (!s) return null
  const t = s.trim().replace(/\s+/g, ' ')
  return t === '' ? null : t
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

mkdirSync(dirname(dbFile), { recursive: true })
const db = new DatabaseSync(dbFile)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 30000')
// Durability is relaxed for the bulk load only: this data is reproducible by
// re-running the import, so trading fsyncs for speed is the right call.
db.exec('PRAGMA synchronous = OFF')
db.exec('PRAGMA cache_size = -200000') // ~200 MB page cache

// Ensure the schema exists when importing into a fresh database (i.e. before
// the app has ever booted). Mirrors server/db/schema.ts.
// Not just SCHEMA_SQL: that is all `CREATE TABLE IF NOT EXISTS`, so on a
// database that already has the tables it adds nothing, and the recipe
// re-roll at the end of this import reads columns a later release added.
// `ensureSchema()` is what the app runs on boot — create *and* catch up.
const { ensureSchema } = await import('../server/utils/db.ts').catch(() => ({}))
if (ensureSchema) {
  ensureSchema(db)
} else {
  const hasFoods = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foods'")
    .get()
  if (!hasFoods) {
    console.error(
      'No `foods` table found. Start the app once to create the schema, then re-run.',
    )
    process.exit(1)
  }
}

const placeholders = INSERT_COLS.map(() => '?').join(', ')
const updates = INSERT_COLS.filter((c) => c !== 'source' && c !== 'barcode')
  .map((c) => `${c} = excluded.${c}`)
  .join(', ')

const upsert = db.prepare(`
  INSERT INTO foods (${INSERT_COLS.join(', ')})
  VALUES (${placeholders})
  ON CONFLICT(source, barcode) DO UPDATE SET ${updates}
`)

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

async function openSource() {
  if (args.file) {
    console.log(`Reading local dump: ${args.file}`)
    return createReadStream(resolve(args.file))
  }
  console.log(`Downloading ${DUMP_URL}`)
  const res = await fetch(DUMP_URL, {
    headers: { 'User-Agent': 'Fittown/0.1 (personal family nutrition tracker)' },
  })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  if (total) console.log(`Size: ${(total / 1e9).toFixed(2)} GB compressed`)
  return Readable.fromWeb(res.body)
}

const source = await openSource()
const gunzip = createGunzip()
// Decompress on a separate step so backpressure is handled by the pipeline.
pipeline(source, gunzip).catch((err) => {
  console.error('\nStream error:', err.message)
  process.exit(1)
})

const rl = createInterface({ input: gunzip, crlfDelay: Infinity })

let header = null
let index = null // offColumn -> position
let seen = 0
let kept = 0
let skippedNoName = 0
let skippedNoNutrition = 0
let skippedCountry = 0
let malformed = 0
const started = Date.now()

const BATCH = 20000
let inBatch = 0
db.exec('BEGIN')

function progress(final = false) {
  const secs = (Date.now() - started) / 1000
  const rate = Math.round(seen / secs)
  const line =
    `  ${seen.toLocaleString()} scanned | ${kept.toLocaleString()} kept | ` +
    `${rate.toLocaleString()}/s | ${secs.toFixed(0)}s`
  process.stdout.write(`\r${line.padEnd(78)}${final ? '\n' : ''}`)
}

for await (const line of rl) {
  if (header === null) {
    header = line.split('\t')
    index = new Map(header.map((h, i) => [h, i]))
    const missing = ['code', 'product_name', 'countries_en'].filter(
      (c) => !index.has(c),
    )
    if (missing.length) {
      console.error(`Dump is missing expected columns: ${missing.join(', ')}`)
      process.exit(1)
    }
    console.log(`Parsed header: ${header.length} columns\n`)
    continue
  }

  seen++
  if (seen % 100000 === 0) progress()

  const cells = line.split('\t')
  // OFF strips tabs/newlines from values, so a short row means a corrupt line.
  if (cells.length !== header.length) {
    malformed++
    continue
  }

  const get = (col) => cells[index.get(col)]

  const countries = get('countries_en') || ''
  if (countryFilter && !countryFilter.some((re) => re.test(countries))) {
    skippedCountry++
    continue
  }

  const name = cleanText(get('product_name'))
  if (!name || name.length < 2) {
    skippedNoName++
    continue
  }

  const barcode = cleanText(get('code'))
  if (!barcode) {
    malformed++
    continue
  }

  const protein = sane(num(get('proteins_100g')), 100)
  const carbs = sane(num(get('carbohydrates_100g')), 100)
  const fat = sane(num(get('fat_100g')), 100)
  const kcal = resolveKcal(get, { protein, carbs, fat })

  // Require enough to be useful in a calorie diary: either a stated energy
  // value or a full macro breakdown we could derive one from.
  if (kcal === null && (protein === null || carbs === null || fat === null)) {
    skippedNoNutrition++
    continue
  }

  const values = [
    'off',
    barcode,
    name.slice(0, 200),
    cleanText(get('brands'))?.slice(0, 120) ?? null,
    cleanText(get('quantity'))?.slice(0, 60) ?? null,
    cleanText(get('categories_en'))?.slice(0, 300) ?? null,
    cleanText(get('image_small_url')),
    cleanText(get('serving_size'))?.slice(0, 60) ?? null,
    sane(num(get('serving_quantity')), 5000),
    isLiquid(get('categories_en'), name),
    kcal,
  ]

  for (const col of NUTRIENT_COLS) {
    const [offCol, scale, max] = NUTRIENTS[col]
    const raw = num(get(offCol))
    // Scale into our storage unit first, then judge plausibility in that unit.
    values.push(raw === null ? null : sane(raw * scale, max))
  }

  values.push(
    cleanText(get('nutriscore_grade'))?.slice(0, 1) ?? null,
    num(get('nova_group')),
    num(get('unique_scans_n')) ?? 0,
  )

  try {
    upsert.run(...values)
    kept++
  } catch (err) {
    malformed++
    if (malformed < 5) console.error(`\nRow error (${barcode}): ${err.message}`)
  }

  if (++inBatch >= BATCH) {
    db.exec('COMMIT')
    db.exec('BEGIN')
    inBatch = 0
  }

  if (kept >= limit) {
    console.log(`\nReached --limit=${limit}, stopping.`)
    break
  }
}

db.exec('COMMIT')
progress(true)

// ---------------------------------------------------------------------------
// Index + finalise
// ---------------------------------------------------------------------------

console.log('\nRebuilding full-text search index...')
db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')")

// A recipe caches the sum of its ingredients, and this import has just
// refreshed the nutrition of every food underneath them. Re-roll them now, or
// last week's chili keeps last week's numbers.
console.log('Recomputing recipes...')
const { recomputeRecipe, recipesInDependencyOrder } = await import('../server/utils/recipes.ts')
// Children before parents — a recipe can hold another recipe. Frozen meals
// are not in this list, and must never be re-rolled.
const recipeRows = recipesInDependencyOrder(db)
db.exec('BEGIN')
for (const recipe of recipeRows) recomputeRecipe(db, recipe.id)
db.exec('COMMIT')
console.log(`  ${recipeRows.length} recipe(s) recomputed`)

console.log('Optimising database...')
db.exec('PRAGMA optimize')
db.exec('ANALYZE')

const { total } = db.prepare('SELECT COUNT(*) AS total FROM foods').get()
const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1)

console.log(`
Import complete in ${elapsed} min
  scanned:            ${seen.toLocaleString()}
  imported:           ${kept.toLocaleString()}
  skipped (country):  ${skippedCountry.toLocaleString()}
  skipped (no name):  ${skippedNoName.toLocaleString()}
  skipped (no data):  ${skippedNoNutrition.toLocaleString()}
  malformed:          ${malformed.toLocaleString()}
  foods in database:  ${total.toLocaleString()}
`)

db.close()

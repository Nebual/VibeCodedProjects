#!/usr/bin/env node
/**
 * Import USDA FoodData Central's Branded Foods into Fittown's SQLite
 * database.
 *
 * Unlike Foundation Foods (a few hundred rows, joined fully in memory), this
 * release is huge: ~2M branded-product rows, but only ~460k distinct
 * barcodes — the rest are historical resubmissions/corrections of the same
 * UPC, sometimes for a genuinely different product (UPCs get retired and
 * reissued by GS1, so the same barcode can legitimately mean something else
 * a few years later). Picking the most-recently-modified US-market row per
 * barcode handles both cases correctly, since "most recent" is always what
 * scanning that barcode resolves to today.
 *
 * That dedup happens FIRST, purely from `branded_food.csv`, before ever
 * touching `food_nutrient.csv` (25.9M rows, by far the biggest file) — this
 * pipeline only keeps nutrient rows for the ~460k surviving fdc_ids, so
 * nothing needs an external staging database.
 *
 * MERGE, not a second row: where a barcode already exists as an OFF row,
 * this updates that row's nutrient columns in place (keeping OFF's name,
 * brand, image, and serving info, which read better than USDA-BF's raw
 * label transcriptions) rather than inserting a duplicate — chosen only
 * when USDA-BF's data is more complete. This importer must be re-run after
 * every `import-off.mjs` refresh: OFF's importer upserts unconditionally on
 * every one of its own listed columns and has no idea a merge ever
 * happened, so a merged barcode's nutrition would silently revert to
 * OFF-only values until USDA-BF runs again.
 *
 * Requires the `unzip` command on PATH.
 *
 * Usage:
 *   node scripts/import-usda-branded.mjs                    # latest known release
 *   node scripts/import-usda-branded.mjs --url=<zip url>    # a newer release
 *   node scripts/import-usda-branded.mjs --dir=<extracted>  # already-extracted CSVs
 *   node scripts/import-usda-branded.mjs --limit=50000      # cap rows read from
 *                                                            # branded_food.csv, for testing
 */
import { DatabaseSync } from 'node:sqlite'
import {
  mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, createWriteStream,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { isLiquid } from './lib/liquid.mjs'
import { streamCsvRecords } from './lib/csv.mjs'

const DEFAULT_URL =
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_branded_food_csv_2025-12-18.zip'

const SOURCE = 'usda_branded'
const OFF_SOURCE = 'off'

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
const branchLimit = args.limit ? Number(args.limit) : Infinity

// ---------------------------------------------------------------------------
// Nutrient mapping
//
// Verified against a real download: Branded Foods reports a *label-style*
// panel, which uses several different nutrient ids than Foundation Foods'
// lab panel for the same real-world nutrient — most notably "Total Sugars"
// (2000, not 1063) and a genuine "Total sugar alcohols" aggregate (1086,
// so no need for Foundation's manual-polyol-summing workaround). Units
// otherwise match our schema directly except two IU-based vitamins, handled
// below.
// ---------------------------------------------------------------------------

const NUTRIENT_MAP = {
  fiber_g: { ids: ['1079'], max: 100 },
  added_sugars_g: { ids: ['1235'], max: 100 },
  sugar_alcohols_g: { ids: ['1086'], max: 100 },
  sat_fat_g: { ids: ['1258'], max: 100 },
  trans_fat_g: { ids: ['1257'], max: 100 },
  mono_fat_g: { ids: ['1292'], max: 100 },
  poly_fat_g: { ids: ['1293'], max: 100 },
  // Individual n-3 fatty acids are almost never broken out on a retail
  // label — kept for consistency with the Foundation importer, but expect
  // this to resolve null for nearly everything.
  omega3_g: { ids: ['1404', '1405', '1407', '1278', '1280', '1272'], max: 100 },
  alcohol_g: { ids: ['1018'], max: 100 },
  water_g: { ids: ['1051'], max: 100 },
  cholesterol_mg: { ids: ['1253'], max: 5_000 },
  sodium_mg: { ids: ['1093'], max: 40_000 },
  caffeine_mg: { ids: ['1057'], max: 10_000 },
  potassium_mg: { ids: ['1092'], max: 6_000 },
  calcium_mg: { ids: ['1087'], max: 5_000 },
  iron_mg: { ids: ['1089'], max: 500 },
  magnesium_mg: { ids: ['1090'], max: 2_000 },
  zinc_mg: { ids: ['1095'], max: 500 },
  phosphorus_mg: { ids: ['1091'], max: 3_000 },
  copper_mg: { ids: ['1098'], max: 50 },
  manganese_mg: { ids: ['1101'], max: 100 },
  vit_c_mg: { ids: ['1162'], max: 5_000 },
  vit_e_mg: { ids: ['1109'], max: 1_000 },
  vit_b1_mg: { ids: ['1165'], max: 200 },
  vit_b2_mg: { ids: ['1166'], max: 200 },
  vit_b3_mg: { ids: ['1167'], max: 500 },
  vit_b6_mg: { ids: ['1175'], max: 200 },
  vit_b12_ug: { ids: ['1178'], max: 1_000 },
  selenium_ug: { ids: ['1103'], max: 10_000 },
  iodine_ug: { ids: ['1100'], max: 100_000 },
  vit_k_ug: { ids: ['1185'], max: 5_000 },
}

/** Columns resolved by a dedicated function below rather than a plain id lookup. */
const SPECIAL_COLS = ['sugars_g', 'vit_a_ug', 'vit_d_ug', 'folate_ug']

const GENERIC_NUTRIENT_COLS = Object.keys(NUTRIENT_MAP)

function sane(value, max) {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0 || value > max) return null
  return value
}

function sumNutrient(amounts, ids, max) {
  let sum = null
  for (const id of ids) {
    const v = amounts.get(id)
    if (v === undefined) continue
    sum = (sum ?? 0) + v
  }
  return sane(sum, max)
}

/** Rarely, an old-style lab id (1063) shows up instead of the label id (2000). */
function resolveSugars(amounts) {
  if (amounts.has('2000')) return sane(amounts.get('2000'), 100)
  if (amounts.has('1063')) return sane(amounts.get('1063'), 100)
  return null
}

/** Vitamin D's IU is defined directly against cholecalciferol mass — an exact, unambiguous conversion. */
const IU_TO_UG_VITAMIN_D = 0.025
function resolveVitD(amounts) {
  if (amounts.has('1114')) return sane(amounts.get('1114'), 1_000)
  if (amounts.has('1110')) return sane(amounts.get('1110') * IU_TO_UG_VITAMIN_D, 1_000)
  return null
}

/**
 * Vitamin A's IU-to-RAE ratio genuinely depends on the source (preformed
 * retinol vs. carotenoids), so unlike vitamin D this is an approximation,
 * not an exact conversion — FDA's own blanket label-conversion factor, used
 * here for lack of a better one on the older IU-style entries.
 */
const IU_TO_UG_VITAMIN_A_RAE = 0.3
function resolveVitA(amounts) {
  if (amounts.has('1106')) return sane(amounts.get('1106'), 100_000)
  if (amounts.has('1104')) return sane(amounts.get('1104') * IU_TO_UG_VITAMIN_A_RAE, 100_000)
  return null
}

/**
 * 1190 "Folate, DFE" (dietary folate equivalents) is the modern FDA label
 * figure; 1177 "Folate, total" is an older equivalent. Deliberately does
 * NOT fall back to 1186 "Folic acid" — that's only the synthetic-
 * fortification portion, not total folate, and would understate it for any
 * food with natural folate too.
 */
function resolveFolate(amounts) {
  if (amounts.has('1190')) return sane(amounts.get('1190'), 10_000)
  if (amounts.has('1177')) return sane(amounts.get('1177'), 10_000)
  return null
}

function resolveNutrient(col, amounts) {
  if (col === 'sugars_g') return resolveSugars(amounts)
  if (col === 'vit_a_ug') return resolveVitA(amounts)
  if (col === 'vit_d_ug') return resolveVitD(amounts)
  if (col === 'folate_ug') return resolveFolate(amounts)
  const spec = NUTRIENT_MAP[col]
  return sumNutrient(amounts, spec.ids, spec.max)
}

const ALL_NUTRIENT_COLS = [...SPECIAL_COLS, ...GENERIC_NUTRIENT_COLS]

function resolveProtein(amounts) {
  return sumNutrient(amounts, ['1003'], 100)
}

/**
 * Branded labels report "Carbohydrate, by difference" (1005) directly for
 * 99.9% of foods — verified against a real sample — so this skips
 * Foundation's Sugars+Fiber+Starch fallback entirely; it isn't needed here
 * and its accuracy problems (see import-usda-foundation.mjs) aren't worth
 * reintroducing for the rare miss.
 */
function resolveCarbs(amounts) {
  return sane(amounts.get('1005') ?? null, 100)
}

function resolveFat(amounts) {
  if (amounts.has('1004')) return sane(amounts.get('1004'), 100)
  if (amounts.has('1085')) return sane(amounts.get('1085'), 100)
  return null
}

function resolveKcal(amounts, protein, carbs, fat) {
  if (amounts.has('1008')) return sane(amounts.get('1008'), 900)
  if (protein === null || carbs === null || fat === null) return null
  return sane(protein * 4 + carbs * 4 + fat * 9, 900)
}

/** Salt isn't reported separately; the standard label-math approximation. */
const SODIUM_TO_SALT = 2.5 / 1000

/** Column order shared by the OFF-row UPDATE and the new-row INSERT — must stay in sync. */
const NUTRIENT_UPDATE_COLS = ['kcal', 'protein_g', 'carbs_g', 'fat_g', ...ALL_NUTRIENT_COLS, 'salt_g']

function countNonNull(values) {
  return values.reduce((n, v) => n + (v === null || v === undefined ? 0 : 1), 0)
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function cleanText(s) {
  if (!s) return null
  const t = String(s).trim().replace(/\s+/g, ' ')
  return t === '' ? null : t
}

/**
 * Branded names are raw label transcriptions, often shouty all-caps
 * ("CAMPBELL'S SLOW KETTLE SOUP CLAM CHOWDER") — only capitalizing after a
 * word boundary (start, space, or open-paren), not blindly re-casing every
 * letter, so an apostrophe-s ("Campbell's") doesn't come out "Campbell'S".
 */
function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s(])([a-z])/g, (_, sep, c) => sep + c.toUpperCase())
}

/**
 * Exact `branded_food_category` values that are genuinely liquid but missed
 * by the shared `isLiquid()` category regex — checked against the full list
 * of 267 real categories in this release, not guessed. Most are singular
 * ("Milk") where the regex only matches the plural ("milks"); "Iced & Bottle
 * Tea" isn't phrased as any of the regex's words at all. Deliberately a
 * short, exact-match, verified list rather than a broader pattern, so a
 * category not checked here defaults to the safer "not liquid".
 */
const LIQUID_CATEGORY_OVERRIDES = new Set([
  'Milk', 'Milk/Milk Substitutes', 'Plant Based Milk',
  'Cream', 'Cream/Cream Substitutes',
  'Iced & Bottle Tea',
])

function brandedIsLiquid(category) {
  if (category && LIQUID_CATEGORY_OVERRIDES.has(category)) return 1
  return isLiquid(category, null)
}

function formatAmount(n) {
  return Number(n).toString()
}

/**
 * `household_serving_fulltext` is frequently OCR/label junk with no actual
 * quantity ("Amount per serving", "PER CAN") rather than a usable label —
 * verified against real rows. A real serving description always has a
 * number in it; anything without one falls back to the plain size+unit.
 */
function servingLabel(row) {
  const hsf = cleanText(row.household_serving_fulltext)
  if (hsf && /\d/.test(hsf)) return hsf.slice(0, 60)
  const size = Number(row.serving_size)
  if (Number.isFinite(size) && size > 0 && row.serving_size_unit) {
    return `${formatAmount(size)} ${row.serving_size_unit}`
  }
  return null
}

function servingGrams(row) {
  const size = Number(row.serving_size)
  return Number.isFinite(size) ? sane(size, 5_000) : null
}

// ---------------------------------------------------------------------------
// Fetch + extract
// ---------------------------------------------------------------------------

let workDir = null

async function resolveDataDir() {
  if (args.dir) return resolve(args.dir)

  workDir = mkdtempSync(join(tmpdir(), 'usda-branded-'))
  const url = args.url || DEFAULT_URL
  const zipPath = join(workDir, 'branded.zip')

  console.log(`Downloading ${url} (this is a ~430MB file)`)
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Fittown/0.1 (personal family nutrition tracker)' },
  })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath))

  console.log('Extracting (uncompresses to ~3GB)...')
  try {
    execFileSync('unzip', ['-oq', zipPath, '-d', workDir])
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        'This script requires the `unzip` command. Install it (e.g. `apt install unzip`) and re-run.',
      )
    }
    throw err
  }

  const entry = readdirSync(workDir).find(
    (e) => e !== 'branded.zip' && statSync(join(workDir, e)).isDirectory(),
  )
  if (!entry) throw new Error('Extracted zip has no top-level directory')
  return join(workDir, entry)
}

// ---------------------------------------------------------------------------
// Pass 1: dedupe branded_food.csv down to one row per barcode
// ---------------------------------------------------------------------------

/** market_country spellings seen in the data for the US. */
const US_MARKETS = new Set(['United States', 'US'])

/**
 * Fields actually used later. `branded_food.csv` has 21 columns per row —
 * notably a free-text `ingredients` list that can run to a thousand-plus
 * characters — and holding the full row for every one of ~2M scanned rows
 * (most of which lose their barcode's dedup and get discarded) is what blew
 * the heap on the first full-scale run. Projecting down to just these
 * fields before it ever goes in the Map keeps the live set proportional to
 * the ~460k *surviving* barcodes, not the 2M rows scanned to find them.
 */
function pickBrandedFields(row, gtin) {
  return {
    fdc_id: row.fdc_id,
    gtin_upc: gtin,
    brand_owner: row.brand_owner,
    brand_name: row.brand_name,
    serving_size: row.serving_size,
    serving_size_unit: row.serving_size_unit,
    household_serving_fulltext: row.household_serving_fulltext,
    branded_food_category: row.branded_food_category,
    data_source: row.data_source,
    modified_date: row.modified_date,
    package_weight: row.package_weight,
  }
}

async function dedupeByBarcode(dataDir) {
  const winners = new Map() // gtin_upc -> slim branded_food.csv row
  let seen = 0
  for await (const row of streamCsvRecords(join(dataDir, 'branded_food.csv'))) {
    if (++seen > branchLimit) break
    if (seen % 500_000 === 0) console.log(`  ...${seen.toLocaleString()} branded_food.csv rows scanned`)

    const gtin = cleanText(row.gtin_upc)
    if (!gtin || !US_MARKETS.has(row.market_country)) continue

    const existing = winners.get(gtin)
    if (!existing || row.modified_date > existing.modified_date) {
      winners.set(gtin, pickBrandedFields(row, gtin))
    }
  }

  const byFdcId = new Map()
  for (const row of winners.values()) byFdcId.set(row.fdc_id, row)
  return byFdcId
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dataDir = await resolveDataDir()

console.log('Pass 1/3: deduping branded_food.csv by barcode...')
const byFdcId = await dedupeByBarcode(dataDir)
const winningFdcIds = new Set(byFdcId.keys())
console.log(`  ${byFdcId.size.toLocaleString()} distinct US-market barcodes`)

console.log('Pass 2/3: reading descriptions from food.csv...')
const descByFdcId = new Map()
for await (const row of streamCsvRecords(join(dataDir, 'food.csv'))) {
  if (winningFdcIds.has(row.fdc_id)) descByFdcId.set(row.fdc_id, row.description)
}

console.log('Pass 3/3: reading food_nutrient.csv (this is the big one, ~26M rows)...')
const amountsByFdcId = new Map()
let nutrientRowsSeen = 0
for await (const row of streamCsvRecords(join(dataDir, 'food_nutrient.csv'))) {
  if (++nutrientRowsSeen % 5_000_000 === 0) {
    console.log(`  ...${nutrientRowsSeen.toLocaleString()} nutrient rows scanned`)
  }
  if (!winningFdcIds.has(row.fdc_id)) continue
  const amount = Number(row.amount)
  if (row.amount === '' || !Number.isFinite(amount)) continue
  if (!amountsByFdcId.has(row.fdc_id)) amountsByFdcId.set(row.fdc_id, new Map())
  amountsByFdcId.get(row.fdc_id).set(row.nutrient_id, amount)
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

mkdirSync(dirname(dbFile), { recursive: true })
const db = new DatabaseSync(dbFile)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 30000')
db.exec('PRAGMA synchronous = OFF')
db.exec('PRAGMA cache_size = -200000')

const { SCHEMA_SQL } = await import('../server/db/schema.ts').catch(() => ({}))
if (SCHEMA_SQL) db.exec(SCHEMA_SQL)

const INSERT_COLS = [
  'source', 'barcode', 'name', 'brand', 'quantity', 'categories',
  'serving_size_text', 'serving_grams', 'is_liquid',
  ...NUTRIENT_UPDATE_COLS,
]
const insertPlaceholders = INSERT_COLS.map(() => '?').join(', ')
const insertUpdates = INSERT_COLS.filter((c) => c !== 'source' && c !== 'barcode')
  .map((c) => `${c} = excluded.${c}`)
  .join(', ')

const insertBranded = db.prepare(`
  INSERT INTO foods (${INSERT_COLS.join(', ')})
  VALUES (${insertPlaceholders})
  ON CONFLICT(source, barcode) DO UPDATE SET ${insertUpdates}
`)

const selectOffRow = db.prepare(
  `SELECT id, ${NUTRIENT_UPDATE_COLS.join(', ')} FROM foods WHERE source = ? AND barcode = ?`,
)
const updateOffRow = db.prepare(
  `UPDATE foods SET ${NUTRIENT_UPDATE_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
)
const deleteServings = db.prepare('DELETE FROM food_servings WHERE food_id = ?')
const insertServing = db.prepare(
  'INSERT INTO food_servings (food_id, label, grams, is_default) VALUES (?, ?, ?, ?)',
)

console.log('Loading existing OFF barcodes for overlap check...')
const offBarcodes = new Set(
  db.prepare("SELECT barcode FROM foods WHERE source = 'off' AND barcode IS NOT NULL")
    .all()
    .map((r) => r.barcode),
)
console.log(`  ${offBarcodes.size.toLocaleString()} OFF barcodes on file`)

let merged = 0
let mergedSkippedOffBetter = 0
let inserted = 0
let skippedNoNutrition = 0

console.log('Writing to the database...')
db.exec('BEGIN')
let inBatch = 0
const BATCH = 5_000

for (const [fdcId, row] of byFdcId) {
  const amounts = amountsByFdcId.get(fdcId) ?? new Map()
  const protein = resolveProtein(amounts)
  const carbs = resolveCarbs(amounts)
  const fat = resolveFat(amounts)
  const kcal = resolveKcal(amounts, protein, carbs, fat)

  if (kcal === null && (protein === null || carbs === null || fat === null)) {
    skippedNoNutrition++
    continue
  }

  const sodium = sumNutrient(amounts, NUTRIENT_MAP.sodium_mg.ids, NUTRIENT_MAP.sodium_mg.max)
  const salt = sodium === null ? null : sane(sodium * SODIUM_TO_SALT, 100)
  const nutrientValues = [
    kcal, protein, carbs, fat,
    ...ALL_NUTRIENT_COLS.map((c) => resolveNutrient(c, amounts)),
    salt,
  ]

  if (offBarcodes.has(row.gtin_upc)) {
    const offRow = selectOffRow.get(OFF_SOURCE, row.gtin_upc)
    if (!offRow) continue // barcode was in the OFF set but the row vanished mid-run; skip rather than guess

    const offValues = NUTRIENT_UPDATE_COLS.map((c) => offRow[c])
    const offCount = countNonNull(offValues)
    const bfCount = countNonNull(nutrientValues)
    const preferBf = bfCount > offCount || (bfCount === offCount && row.data_source === 'GDSN')

    if (preferBf) {
      updateOffRow.run(...nutrientValues, offRow.id)
      merged++
    } else {
      mergedSkippedOffBetter++
    }
  } else {
    const name = cleanText(descByFdcId.get(fdcId))
    if (!name) {
      skippedNoNutrition++
      continue
    }
    const brand = cleanText(row.brand_name) ?? cleanText(row.brand_owner)
    const values = [
      SOURCE,
      row.gtin_upc,
      titleCase(name).slice(0, 200),
      brand ? titleCase(brand).slice(0, 120) : null,
      cleanText(row.package_weight)?.slice(0, 60) ?? null,
      cleanText(row.branded_food_category)?.slice(0, 300) ?? null,
      servingLabel(row),
      servingGrams(row),
      // Category alone, deliberately not name — branded_food_category is
      // present and reliable for ~99% of rows (unlike OFF's sparse
      // categories), but the NAME check is actively wrong here: branded
      // names routinely end in a packing liquid or product-type word that
      // isn't a liquid-food signal ("Chunk Light Tuna In Water", "Chamomile
      // Herbal Tea" for dry tea bags) — verified against real rows, both
      // misclassified as liquid before this was passed null.
      brandedIsLiquid(row.branded_food_category),
      ...nutrientValues,
    ]

    const info = insertBranded.run(...values)
    const foodId = info.lastInsertRowid
    deleteServings.run(foodId)
    const label = servingLabel(row)
    const grams = servingGrams(row)
    if (label && grams) insertServing.run(foodId, label, grams, 1)
    inserted++
  }

  if (++inBatch >= BATCH) {
    db.exec('COMMIT')
    db.exec('BEGIN')
    inBatch = 0
  }
}
db.exec('COMMIT')

console.log('Rebuilding full-text search index...')
db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')")

console.log('Recomputing recipes...')
const { recomputeRecipe } = await import('../server/utils/recipes.ts')
const recipeRows = db.prepare("SELECT id FROM foods WHERE source = 'recipe'").all()
db.exec('BEGIN')
for (const recipe of recipeRows) recomputeRecipe(db, recipe.id)
db.exec('COMMIT')

console.log('Optimising database...')
db.exec('PRAGMA optimize')
db.exec('ANALYZE')

const { total } = db.prepare('SELECT COUNT(*) AS total FROM foods WHERE source = ?').get(SOURCE)

console.log(`
Import complete
  distinct barcodes seen:        ${byFdcId.size.toLocaleString()}
  merged into an OFF row:        ${merged.toLocaleString()}
  OFF row kept (already better): ${mergedSkippedOffBetter.toLocaleString()}
  inserted as new usda_branded:  ${inserted.toLocaleString()}
  skipped (no nutrition/name):   ${skippedNoNutrition.toLocaleString()}
  usda_branded rows in database: ${total.toLocaleString()}
`)

db.close()
if (workDir) rmSync(workDir, { recursive: true, force: true })

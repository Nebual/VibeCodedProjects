#!/usr/bin/env node
/**
 * Import USDA FoodData Central's Foundation Foods into Fittown's SQLite
 * database.
 *
 * Unlike Open Food Facts' single denormalised CSV, FDC ships a relational
 * bundle of ~20 tables per release. Foundation Foods is small (a few hundred
 * lab-analysed generic ingredients, no brands/barcodes), so the whole bundle
 * is read into memory and joined there rather than streamed.
 *
 * Rows are upserted on (source, barcode), reusing `fdc_id` as the "barcode"
 * for dedup purposes — there is no real barcode for a generic ingredient, but
 * this keeps food ids (and any diary entries pointing at them) stable across
 * re-imports, exactly like the OFF importer does with UPCs.
 *
 * Requires the `unzip` command on PATH.
 *
 * Usage:
 *   node scripts/import-usda-foundation.mjs                    # latest known release
 *   node scripts/import-usda-foundation.mjs --url=<zip url>    # a newer release
 *   node scripts/import-usda-foundation.mjs --dir=<extracted>  # already-extracted CSVs
 */
import { DatabaseSync } from 'node:sqlite'
import {
  mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, readFileSync,
  createWriteStream,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { isLiquid } from './lib/liquid.mjs'
import { parseCsvRecords } from './lib/csv.mjs'

// FDC publishes a new Foundation Foods release every few months at a URL
// that embeds the release date. There is no "latest" alias, so this needs
// bumping occasionally — pass --url to use a newer one without editing this.
const DEFAULT_URL =
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2025-12-18.zip'

const SOURCE = 'usda_foundation'

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

// ---------------------------------------------------------------------------
// Nutrient mapping
//
// FDC reports nutrients as rows keyed by a stable numeric `nutrient_id`
// (unchanged since USDA's SR days) rather than as fixed CSV columns, so each
// db column maps to one or more ids to sum. Units already match our schema
// (mg -> _mg, µg -> _ug, g -> _g) — verified against a real download rather
// than assumed — so no per-nutrient scale factor is needed here, unlike OFF's
// importer which has to convert OFF's grams-of-everything convention.
//
// `max` mirrors the plausibility ceilings in import-off.mjs: a physically
// implausible value is more likely a data error than a genuine extreme, and
// null ("unknown") is safer than a wrong number for a day's totals.
// ---------------------------------------------------------------------------

const NUTRIENT_MAP = {
  fiber_g: { ids: [1079], max: 100 },
  sugars_g: { ids: [1063], max: 100 },
  added_sugars_g: { ids: [1235], max: 100 },
  // No single "total sugar alcohols" id; sum the individual polyols FDC does
  // report. Rarely populated for raw/generic foods, which is expected.
  sugar_alcohols_g: { ids: [1055, 1056], max: 100 },
  sat_fat_g: { ids: [1258], max: 100 },
  trans_fat_g: { ids: [1257], max: 100 },
  mono_fat_g: { ids: [1292], max: 100 },
  poly_fat_g: { ids: [1293], max: 100 },
  // No single "total omega-3" id either; sum the individual n-3 fatty acids:
  // ALA, EPA, DPA, DHA and two rarer ones. Under-counts if some are simply
  // unmeasured for a given food, but that's the best available estimate.
  omega3_g: { ids: [1404, 1405, 1407, 1278, 1280, 1272], max: 100 },
  alcohol_g: { ids: [1018], max: 100 },
  water_g: { ids: [1051], max: 100 },
  cholesterol_mg: { ids: [1253], max: 5_000 },
  sodium_mg: { ids: [1093], max: 40_000 },
  caffeine_mg: { ids: [1057], max: 10_000 },
  potassium_mg: { ids: [1092], max: 6_000 },
  calcium_mg: { ids: [1087], max: 5_000 },
  iron_mg: { ids: [1089], max: 500 },
  magnesium_mg: { ids: [1090], max: 2_000 },
  zinc_mg: { ids: [1095], max: 500 },
  phosphorus_mg: { ids: [1091], max: 3_000 },
  copper_mg: { ids: [1098], max: 50 },
  manganese_mg: { ids: [1101], max: 100 },
  vit_c_mg: { ids: [1162], max: 5_000 },
  vit_e_mg: { ids: [1109], max: 1_000 },
  vit_b1_mg: { ids: [1165], max: 200 },
  vit_b2_mg: { ids: [1166], max: 200 },
  vit_b3_mg: { ids: [1167], max: 500 },
  vit_b6_mg: { ids: [1175], max: 200 },
  selenium_ug: { ids: [1103], max: 10_000 },
  iodine_ug: { ids: [1100], max: 100_000 },
  vit_a_ug: { ids: [1106], max: 100_000 },
  vit_d_ug: { ids: [1114], max: 1_000 },
  vit_k_ug: { ids: [1185], max: 5_000 },
  folate_ug: { ids: [1177], max: 10_000 },
  vit_b12_ug: { ids: [1178], max: 1_000 },
}

const NUTRIENT_COLS = Object.keys(NUTRIENT_MAP)

// Energy fallback chain: a directly-measured kcal value (1008) beats a
// macro-derived Atwater estimate (2047 general factors, else 2048 specific
// factors) — FDC provides whichever it has. Lab data doesn't suffer OFF's
// kJ-typed-as-kcal entry error, so no cross-check against macros is needed.
const KCAL_IDS = [1008, 2047, 2048]
const MAX_KCAL_PER_100G = 900

/**
 * Fat fallback: 1004 "Total lipid (fat)" is the analytical total; a handful
 * of oils only report 1085 "Total fat (NLEA)" instead, a legally-defined
 * labeling figure that runs consistently a bit lower (e.g. salted butter:
 * 82.2g total lipid vs 65.0g NLEA — not a data error, a different legal
 * accounting of what counts as fat). Verified across the full release: of
 * the 83 foods that report both, none rely on the fallback, and zero
 * already-imported foods are missing 1004 while having 1085 — so this can
 * only ever fire for foods that previously had neither (the oils).
 */
const MAX_FAT = 100

function resolveFat(amounts) {
  if (amounts.has('1004')) return sane(amounts.get('1004'), MAX_FAT)
  if (amounts.has('1085')) return sane(amounts.get('1085'), MAX_FAT)
  return null
}

/**
 * Carbs fallback: 1005 "Carbohydrate, by difference" is the standard figure;
 * when absent, sum whatever of 1063 Sugars/1079 Fiber/1009 Starch is present
 * — USDA's own "by summation" method (nutrient 1050), just computed by hand
 * since 1050 itself is rarely populated. Verified against the ~265 foods in
 * this release that have both: tracks by-difference closely for high-water
 * produce (carrots 7.92g real vs 7.78g summed; milk 4.91 vs 4.89) but badly
 * undercounts dense starchy foods — several flours are 60-79g off. The 17
 * dry beans fall in that riskier bucket (median error is likely ~15-20g);
 * imported anyway per an explicit call, since a rough figure for a food
 * people actually cook beats none.
 */
const MAX_CARBS = 100
const CARB_SUM_IDS = ['1063', '1079', '1009']

function resolveCarbs(amounts) {
  if (amounts.has('1005')) return sane(amounts.get('1005'), MAX_CARBS)
  let sum = null
  for (const id of CARB_SUM_IDS) {
    const v = amounts.get(id)
    if (v === undefined) continue
    sum = (sum ?? 0) + v
  }
  return sane(sum, MAX_CARBS)
}

/**
 * Foods where an unmeasured macro is a genuine zero (or near enough), not
 * "unknown" — FDC only records what it bothered to measure, so these would
 * otherwise be skipped for lacking data they were never going to have:
 *  - table salt: no protein/carbs/fat by any label:
 *      321505 Salt, table, iodized
 *  - cooking oils: no protein/carbs by any label (fat itself is present via
 *    the 1085 NLEA fallback above, so only p/c need zeroing here):
 *      748278 canola, 748323 corn, 748366 soybean, 748608 olive extra
 *      virgin, 1750348 peanut, 1750349 sunflower, 1750350 safflower,
 *      1750351 olive extra light
 *  - raw produce/juice: FDC didn't bother measuring fat at all for these —
 *    reasonable, since raw fruit/veg/juice runs a few tenths of a gram per
 *    100g on any label, i.e. genuinely trace:
 *      2727577 pawpaw, 2727578 pie pumpkin, 2727579 spaghetti squash,
 *      2727580 rutabaga, 2727581 blackberries, 2727582 tomatillos,
 *      2727583 napa cabbage, 2727584 leeks, 2727585 green onion,
 *      2727586 shallots, 2727587 prune juice, 2727588 pomegranate juice,
 *      2727589 tart cherry juice, 2747675 watermelon
 */
const TRACE_MACRO_FOODS = new Set([
  '321505',
  '748278', '748323', '748366', '748608', '1750348', '1750349', '1750350', '1750351',
  '2727577', '2727578', '2727579', '2727580', '2727581', '2727582', '2727583',
  '2727584', '2727585', '2727586', '2727587', '2727588', '2727589', '2747675',
])

/** Only used once kcal isn't directly reported — same Atwater constants FDC's own 2047/2048 apply. */
function atwaterKcal(protein, carbs, fat) {
  if (protein === null || carbs === null || fat === null) return null
  return sane(protein * 4 + carbs * 4 + fat * 9, MAX_KCAL_PER_100G)
}

/** Salt isn't reported separately; the standard label-math approximation. */
const SODIUM_TO_SALT = 2.5 / 1000

/**
 * USDA's food_category is a coarse 29-way food-group grouping, not a
 * per-item tag like OFF's — "Fruits and Fruit Juices" covers both a raw
 * banana and actual juice, so it would otherwise make `isLiquid` (which
 * looks for "juices" as a category word) call every raw fruit a liquid.
 * "Beverages"/"Alcoholic Beverages" are unambiguous and kept.
 */
const AMBIGUOUS_CATEGORY = 'Fruits and Fruit Juices'

/**
 * USDA names lead with the defining noun ("Milk, reduced fat, fluid, 2%...",
 * "Yogurt, plain, whole milk") — the opposite of OFF's product-name-last
 * convention ("Chocolate Milk"), which is what `isLiquid`'s trailing-word
 * check assumes. Reused verbatim would call "Yogurt, ..., whole milk" and
 * "Cheese, ricotta, whole milk" liquids because they end in "milk". Checking
 * the leading clause instead reads USDA's names correctly.
 */
const LEADING_LIQUID_NOUN =
  /^\s*(water|juice|soda|cola|lemonade|smoothie|kombucha|seltzer|beer|wine|cider|milk|coffee|tea|drink|ale|latte|espresso)s?\b/i

function usdaIsLiquid(categories, name) {
  if (isLiquid(categories === AMBIGUOUS_CATEGORY ? null : categories, null)) return 1
  return LEADING_LIQUID_NOUN.test(name.split(',')[0]) ? 1 : 0
}

const INSERT_COLS = [
  'source', 'barcode', 'name', 'categories', 'serving_size_text',
  'serving_grams', 'is_liquid', 'kcal', 'protein_g', 'carbs_g', 'fat_g',
  ...NUTRIENT_COLS, 'salt_g',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(cell) {
  if (cell === undefined || cell === '') return null
  const n = Number(cell)
  return Number.isFinite(n) ? n : null
}

function sane(value, max) {
  if (value === null) return null
  if (value < 0 || value > max) return null
  return value
}

function cleanText(s) {
  if (!s) return null
  const t = s.trim().replace(/\s+/g, ' ')
  return t === '' ? null : t
}

/** "2.0" -> "2", "0.5" -> "0.5" — USDA amounts are always whole or halves. */
function formatAmount(n) {
  return Number(n).toString()
}

function labelFor(amount, unitName, modifier) {
  const base = `${formatAmount(amount)} ${unitName}`
  return modifier ? `${base} ${modifier}` : base
}

function readCsv(dir, file) {
  return parseCsvRecords(readFileSync(join(dir, file), 'utf8'))
}

// ---------------------------------------------------------------------------
// Fetch + extract
// ---------------------------------------------------------------------------

let workDir = null

async function resolveDataDir() {
  if (args.dir) return resolve(args.dir)

  workDir = mkdtempSync(join(tmpdir(), 'usda-foundation-'))
  const url = args.url || DEFAULT_URL
  const zipPath = join(workDir, 'foundation.zip')

  console.log(`Downloading ${url}`)
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Fittown/0.1 (personal family nutrition tracker)' },
  })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath))

  console.log('Extracting...')
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
    (e) => e !== 'foundation.zip' && statSync(join(workDir, e)).isDirectory(),
  )
  if (!entry) throw new Error('Extracted zip has no top-level directory')
  return join(workDir, entry)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dataDir = await resolveDataDir()

console.log('Reading CSVs...')
const foodRows = readCsv(dataDir, 'food.csv')
const categoryRows = readCsv(dataDir, 'food_category.csv')
const nutrientRows = readCsv(dataDir, 'food_nutrient.csv')
const portionRows = readCsv(dataDir, 'food_portion.csv')
const unitRows = readCsv(dataDir, 'measure_unit.csv')

const categoryById = new Map(categoryRows.map((r) => [r.id, r.description]))
const unitById = new Map(unitRows.map((r) => [r.id, r.name]))

const foundationFoods = foodRows.filter((r) => r.data_type === 'foundation_food')
const foundationIds = new Set(foundationFoods.map((r) => r.fdc_id))

console.log(`${foundationFoods.length} Foundation Foods (of ${foodRows.length} food.csv rows — the rest are the lab's underlying samples/acquisitions)`)

/** fdc_id -> Map(nutrient_id -> amount) */
const amountsByFood = new Map()
for (const r of nutrientRows) {
  if (!foundationIds.has(r.fdc_id)) continue
  const amount = num(r.amount)
  if (amount === null) continue
  if (!amountsByFood.has(r.fdc_id)) amountsByFood.set(r.fdc_id, new Map())
  amountsByFood.get(r.fdc_id).set(r.nutrient_id, amount)
}

/** fdc_id -> [{ amount, unitName, modifier, gramWeight }], in file order. */
const portionsByFood = new Map()
for (const r of portionRows) {
  if (!foundationIds.has(r.fdc_id)) continue
  const gramWeight = num(r.gram_weight)
  const amount = num(r.amount)
  const unitName = unitById.get(r.measure_unit_id)
  if (gramWeight === null || amount === null || !unitName) continue
  if (!portionsByFood.has(r.fdc_id)) portionsByFood.set(r.fdc_id, [])
  portionsByFood.get(r.fdc_id).push({
    amount,
    unitName,
    modifier: cleanText(r.modifier),
    gramWeight: sane(gramWeight, 5000),
  })
}

function sumNutrient(amounts, ids, max) {
  let sum = null
  for (const id of ids) {
    const v = amounts.get(String(id))
    if (v === undefined) continue
    sum = (sum ?? 0) + v
  }
  return sane(sum, max)
}

function resolveKcal(amounts) {
  for (const id of KCAL_IDS) {
    const v = amounts.get(String(id))
    if (v !== undefined) return sane(v, MAX_KCAL_PER_100G)
  }
  return null
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

mkdirSync(dirname(dbFile), { recursive: true })
const db = new DatabaseSync(dbFile)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 30000')

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
    console.error('No `foods` table found. Start the app once to create the schema, then re-run.')
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

const deleteServings = db.prepare('DELETE FROM food_servings WHERE food_id = ?')
const insertServing = db.prepare(
  'INSERT INTO food_servings (food_id, label, grams, is_default) VALUES (?, ?, ?, ?)',
)

let imported = 0
let skippedNoNutrition = 0

db.exec('BEGIN')
for (const food of foundationFoods) {
  const name = cleanText(food.description)
  if (!name) continue

  const amounts = amountsByFood.get(food.fdc_id) ?? new Map()
  let protein = sumNutrient(amounts, ['1003'], 100)
  let carbs = resolveCarbs(amounts)
  let fat = resolveFat(amounts)

  if (TRACE_MACRO_FOODS.has(food.fdc_id)) {
    if (protein === null) protein = 0
    if (carbs === null) carbs = 0
    if (fat === null) fat = 0
  }

  // FDC doesn't report kcal directly for everything it reports full macros
  // for (raw produce/beans, mainly) — derive it the same way FDC's own
  // 2047/2048 columns do rather than leaving a computable value null.
  const kcal = resolveKcal(amounts) ?? atwaterKcal(protein, carbs, fat)

  // Same bar as the OFF importer: a diary is only useful with either a
  // stated energy value or a full macro breakdown.
  if (kcal === null && (protein === null || carbs === null || fat === null)) {
    skippedNoNutrition++
    continue
  }

  const categories = categoryById.get(food.food_category_id) ?? null
  const portions = portionsByFood.get(food.fdc_id) ?? []
  const defaultPortion = portions[0]

  const values = [
    SOURCE,
    food.fdc_id,
    name.slice(0, 200),
    categories?.slice(0, 300) ?? null,
    defaultPortion ? labelFor(defaultPortion.amount, defaultPortion.unitName, defaultPortion.modifier) : null,
    defaultPortion?.gramWeight ?? null,
    usdaIsLiquid(categories, name),
    kcal,
    protein,
    carbs,
    fat,
  ]
  for (const col of NUTRIENT_COLS) {
    const { ids, max } = NUTRIENT_MAP[col]
    values.push(sumNutrient(amounts, ids, max))
  }
  const sodium = sumNutrient(amounts, NUTRIENT_MAP.sodium_mg.ids, NUTRIENT_MAP.sodium_mg.max)
  values.push(sodium === null ? null : sane(sodium * SODIUM_TO_SALT, 100))

  const info = upsert.run(...values)
  const foodId = info.lastInsertRowid

  deleteServings.run(foodId)
  for (const p of portions) {
    insertServing.run(
      foodId,
      labelFor(p.amount, p.unitName, p.modifier),
      p.gramWeight,
      p === defaultPortion ? 1 : 0,
    )
  }

  imported++
}
db.exec('COMMIT')

console.log('Rebuilding full-text search index...')
db.exec("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')")

console.log('Recomputing recipes...')
const { recomputeRecipe, recipesInDependencyOrder } = await import('../server/utils/recipes.ts')
// Children before parents — a recipe can hold another recipe. Frozen meals
// are not in this list, and must never be re-rolled.
const recipeRows = recipesInDependencyOrder(db)
db.exec('BEGIN')
for (const recipe of recipeRows) recomputeRecipe(db, recipe.id)
db.exec('COMMIT')

console.log('Optimising database...')
db.exec('PRAGMA optimize')
db.exec('ANALYZE')

const { total } = db.prepare('SELECT COUNT(*) AS total FROM foods WHERE source = ?').get(SOURCE)

console.log(`
Import complete
  foundation foods seen:  ${foundationFoods.length}
  imported:               ${imported}
  skipped (no nutrition): ${skippedNoNutrition}
  usda_foundation rows in database: ${total}
`)

db.close()
if (workDir) rmSync(workDir, { recursive: true, force: true })

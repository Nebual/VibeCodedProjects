import { NUTRIENT_KEYS } from '#shared/nutrients'
import { foodCols } from '../../utils/foods'

/**
 * Create a custom food.
 *
 * Nutrients arrive as "per serving" or "per 100 g" depending on what the label
 * in front of the user says; we normalise to per-100g on the way in, since
 * that's the only basis the rest of the app understands.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const name = assertText(body.name, 'name', 200)
  const brand = optionalText(body.brand, 120)
  const barcode = optionalText(body.barcode, 20)
  const isLiquid = body.is_liquid ? 1 : 0

  // The amount the entered nutrients describe.
  const basisGrams = assertNumber(body.basis_grams, 'basis_grams', { min: 0.1, max: 10000 })
  const servingGrams = optionalNumber(body.serving_grams, 'serving_grams', { min: 0.1, max: 10000 })
  const servingText = optionalText(body.serving_size_text, 60)

  const factor = 100 / basisGrams

  const nutrients: Record<string, number | null> = {}
  for (const key of NUTRIENT_KEYS) {
    const value = optionalNumber(body[key], key, { min: 0, max: 1_000_000 })
    nutrients[key] = value === null ? null : value * factor
  }

  if (nutrients.kcal === null) {
    // Derive from macros rather than rejecting — people often only know these.
    const { protein_g: p, carbs_g: c, fat_g: f } = nutrients
    if (p !== null || c !== null || f !== null) {
      nutrients.kcal = (p ?? 0) * 4 + (c ?? 0) * 4 + (f ?? 0) * 9
    } else {
      throw createError({
        statusCode: 400,
        statusMessage: 'Enter calories, or at least protein/carbs/fat',
      })
    }
  }

  const cols = ['source', 'owner_user_id', 'name', 'brand', 'barcode', 'is_liquid',
    'serving_grams', 'serving_size_text', ...NUTRIENT_KEYS]
  const values = ['custom', user.id, name, brand, barcode, isLiquid,
    servingGrams, servingText, ...NUTRIENT_KEYS.map((k) => nutrients[k])]

  const db = useDb()
  const info = db
    .prepare(
      `INSERT INTO foods (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    )
    .run(...values)

  const id = Number(info.lastInsertRowid)

  // Custom foods aren't covered by the importer's bulk FTS rebuild, so index
  // this row now to make it immediately searchable.
  db.prepare('INSERT INTO foods_fts(rowid, name, brand) VALUES (?, ?, ?)').run(
    id,
    name,
    brand,
  )

  const food = db.prepare(`SELECT ${foodCols()} FROM foods f WHERE f.id = ?`).get(id)
  return { food }
})

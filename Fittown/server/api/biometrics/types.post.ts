/**
 * Define a measurement to track, e.g. "Bicep" in cm.
 *
 * Re-posting an existing name updates its unit rather than erroring — the
 * realistic case is someone fixing "cm" to "in" right after creating it, and a
 * duplicate-name error there would just be in the way.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const name = assertText(body.name, 'name', 40)
  const unit = assertText(body.unit, 'unit', 12)
  const sortOrder = optionalNumber(body.sort_order, 'sort_order', { min: 0, max: 1000 })

  const db = useDb()
  db.prepare(
    `INSERT INTO biometric_types (user_id, name, unit, sort_order)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, name) DO UPDATE SET unit = excluded.unit`,
  ).run(user.id, name, unit, sortOrder ?? 0)

  const type = db
    .prepare('SELECT id, name, unit, sort_order FROM biometric_types WHERE user_id = ? AND name = ?')
    .get(user.id, name)

  return { type }
})

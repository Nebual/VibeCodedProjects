/**
 * Record (or clear) one measurement for one day.
 *
 * A null value deletes the reading rather than storing a zero — "I didn't
 * measure my bicep today" and "my bicep is 0 cm" must not collapse into the
 * same row, the same way a missing nutrient is never coerced to zero.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const typeId = assertId(body.type_id, 'type_id')
  const value = optionalNumber(body.value, 'value', { min: -1000, max: 10000 })

  const db = useDb()
  const owned = db
    .prepare('SELECT id FROM biometric_types WHERE id = ? AND user_id = ?')
    .get(typeId, user.id)
  if (!owned) throw createError({ statusCode: 404, statusMessage: 'Measurement not found' })

  if (value === null) {
    db.prepare(
      'DELETE FROM biometric_entries WHERE user_id = ? AND type_id = ? AND date = ?',
    ).run(user.id, typeId, day)
    return { ok: true, value: null }
  }

  db.prepare(
    `INSERT INTO biometric_entries (user_id, type_id, date, value)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, type_id, date) DO UPDATE SET value = excluded.value`,
  ).run(user.id, typeId, day, value)

  return { ok: true, value }
})

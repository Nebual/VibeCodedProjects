/**
 * Log water. Amounts are always stored in millilitres; the UI converts for
 * users who prefer fluid ounces.
 *
 * A negative amount is allowed so the UI's "undo" button can subtract a glass
 * without needing to know which row to delete.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const amount = assertNumber(body.amount_ml, 'amount_ml', { min: -5000, max: 5000 })
  if (amount === 0) {
    throw createError({ statusCode: 400, statusMessage: 'amount_ml cannot be zero' })
  }

  const info = useDb()
    .prepare('INSERT INTO water_entries (user_id, date, amount_ml) VALUES (?, ?, ?)')
    .run(user.id, day, amount)

  const { total } = useDb()
    .prepare(
      'SELECT COALESCE(SUM(amount_ml), 0) AS total FROM water_entries WHERE user_id = ? AND date = ?',
    )
    .get(user.id, day) as { total: number }

  return { id: Number(info.lastInsertRowid), total_ml: total }
})

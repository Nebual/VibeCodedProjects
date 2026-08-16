/** Record today's weight. One reading per day — a re-post replaces it. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const kg = assertNumber(body.weight_kg, 'weight_kg', { min: 10, max: 700 })

  useDb()
    .prepare(
      `INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET weight_kg = excluded.weight_kg`,
    )
    .run(user.id, day, kg)

  return { ok: true, weight_kg: kg }
})

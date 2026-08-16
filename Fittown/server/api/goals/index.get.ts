export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()

  const goals = db.prepare('SELECT * FROM user_goals WHERE user_id = ?').get(user.id)

  // The calorie calculator needs a current weight, and Settings shouldn't have
  // to pull a whole summary range to find one. "Latest" rather than "today's":
  // yesterday's weigh-in is a much better input than no weight at all.
  const latest = db
    .prepare(
      `SELECT date, weight_kg FROM weight_entries
       WHERE user_id = ? ORDER BY date DESC LIMIT 1`,
    )
    .get(user.id) as { date: string; weight_kg: number } | undefined

  return { goals, latest_weight: latest ?? null }
})

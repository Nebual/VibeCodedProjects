/**
 * Remove a day's weight reading.
 *
 * Keyed by date rather than row id because there is only ever one reading per
 * day (the table has a UNIQUE(user_id, date)), and the caller — the diary —
 * already knows which day it is looking at.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const day = assertDate(getRouterParam(event, 'date'))

  useDb()
    .prepare('DELETE FROM weight_entries WHERE user_id = ? AND date = ?')
    .run(user.id, day)

  return { ok: true }
})

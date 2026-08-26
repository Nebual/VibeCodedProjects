import { assertBoolean } from '../../../utils/validate'

/**
 * Tick (or untick) one reminder for one day.
 *
 * The tick belongs to the day, not the reminder — the same reminder starts
 * unticked tomorrow and stays ticked when you navigate back to this day.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const reminderId = assertId(id, 'reminder_id')
  const done = assertBoolean(body.done, 'done')

  const db = useDb()
  const owned = db
    .prepare('SELECT id FROM reminders WHERE id = ? AND user_id = ?')
    .get(reminderId, user.id)
  if (!owned) throw createError({ statusCode: 404, statusMessage: 'Reminder not found' })

  if (done) {
    db.prepare(
      `INSERT INTO reminder_checks (user_id, reminder_id, date, done) VALUES (?, ?, ?, 1)
       ON CONFLICT(user_id, reminder_id, date) DO UPDATE SET done = 1`,
    ).run(user.id, reminderId, day)
    return { ok: true, done: true }
  }

  db.prepare(
    'DELETE FROM reminder_checks WHERE user_id = ? AND reminder_id = ? AND date = ?',
  ).run(user.id, reminderId, day)
  return { ok: true, done: false }
})

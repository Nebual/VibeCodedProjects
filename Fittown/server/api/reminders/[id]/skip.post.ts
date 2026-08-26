import { assertId } from '../../../utils/validate'

/**
 * Skip one occurrence ("Delete Today's") — hides the reminder on the day
 * being viewed without touching the schedule or any other day. Stored as a
 * done=0 check row, which the diary query filters out.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const reminderId = assertId(id, 'reminder_id')

  const db = useDb()
  const owned = db
    .prepare('SELECT id FROM reminders WHERE id = ? AND user_id = ?')
    .get(reminderId, user.id)
  if (!owned) throw createError({ statusCode: 404, statusMessage: 'Reminder not found' })

  db.prepare(
    `INSERT INTO reminder_checks (user_id, reminder_id, date, done) VALUES (?, ?, ?, 0)
     ON CONFLICT(user_id, reminder_id, date) DO UPDATE SET done = 0`,
  ).run(user.id, reminderId, day)

  return { ok: true }
})

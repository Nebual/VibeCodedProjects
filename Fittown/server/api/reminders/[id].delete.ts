import { assertId } from '../../utils/validate'

/**
 * Remove a reminder — from the day being viewed onward.
 *
 * The row is kept with `removed_on` set to that day, not deleted. The diary
 * query shows a reminder on days `created_on <= day < removed_on`, so past
 * days keep the checkbox they had while this day and every later one lose it.
 * (The UI asks for confirmation before calling this.)
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const reminderId = assertId(id, 'reminder_id')

  const db = useDb()
  const info = db
    .prepare('UPDATE reminders SET removed_on = ? WHERE id = ? AND user_id = ? AND removed_on IS NULL')
    .run(day, reminderId, user.id)

  if (info.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Reminder not found' })
  }

  return { ok: true }
})

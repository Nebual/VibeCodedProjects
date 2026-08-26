import { assertDate, assertId } from '../../../utils/validate'
import { normalizeSchedule } from '#shared/reminders'

/**
 * Change a reminder's recurrence — from the day being viewed onward.
 *
 * Appends a new rule to the schedule history rather than overwriting, so
 * every past day keeps evaluating against the rule that was in force then:
 * move Garbage from every-other-Thursday to every-other-Friday and the past
 * stays on Thursdays. (The UI asks for confirmation before calling this.)
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const reminderId = assertId(id, 'reminder_id')

  const normalized = normalizeSchedule({
    freq: body.freq,
    interval: body.interval,
    byweekday: body.byweekday,
    day_of_month: body.day_of_month,
  })
  if (!normalized.ok) {
    throw createError({ statusCode: 400, statusMessage: normalized.error })
  }

  return transact((db) => {
    const owned = db
      .prepare('SELECT id FROM reminders WHERE id = ? AND user_id = ?')
      .get(reminderId, user.id)
    if (!owned) throw createError({ statusCode: 404, statusMessage: 'Reminder not found' })

    // A rule already taking effect this exact day is replaced, not stacked —
    // two edits in one sitting shouldn't leave the older half behind.
    db.prepare(
      'DELETE FROM reminder_schedules WHERE reminder_id = ? AND effective_from = ?',
    ).run(reminderId, day)

    db.prepare(
      `INSERT INTO reminder_schedules
         (reminder_id, effective_from, freq, interval, byweekday, day_of_month)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      reminderId,
      day,
      normalized.rule.freq,
      normalized.rule.interval,
      normalized.rule.byweekday.join(','),
      normalized.rule.day_of_month,
    )

    return { ok: true }
  })
})

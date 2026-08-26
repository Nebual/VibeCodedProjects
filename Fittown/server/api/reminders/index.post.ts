import { assertDate, assertText } from '../../utils/validate'
import { dayOfMonthOf, normalizeSchedule } from '#shared/reminders'

/**
 * Add a reminder, starting on the day being viewed (usually today).
 *
 * A first schedule row (daily) is written alongside the reminder itself —
 * every reminder has at least one rule, so evaluation never falls off the
 * end of its history. The row is never deleted when the user removes it —
 * see [id].delete.ts — which is what lets past days keep showing a checkbox
 * for something they stopped tracking later.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const name = assertText(body.name, 'name', 60)

  // Optional initial recurrence; defaults to daily.
  const normalized = normalizeSchedule({
    freq: body.freq ?? 'daily',
    interval: body.interval,
    byweekday: body.byweekday,
    day_of_month: body.day_of_month ?? dayOfMonthOf(day),
  })
  if (!normalized.ok) {
    throw createError({ statusCode: 400, statusMessage: normalized.error })
  }

  return transact((db) => {
    const { next } = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM reminders WHERE user_id = ?')
      .get(user.id) as { next: number }

    const info = db
      .prepare(
        'INSERT INTO reminders (user_id, name, created_on, sort_order) VALUES (?, ?, ?, ?)',
      )
      .run(user.id, name, day, next)

    db.prepare(
      `INSERT INTO reminder_schedules
         (reminder_id, effective_from, freq, interval, byweekday, day_of_month)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(info.lastInsertRowid),
      day,
      normalized.rule.freq,
      normalized.rule.interval,
      normalized.rule.byweekday.join(','),
      normalized.rule.day_of_month,
    )

    return { id: Number(info.lastInsertRowid) }
  })
})

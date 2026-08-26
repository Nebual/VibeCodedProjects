import { assertText } from '../../utils/validate'

/**
 * Add a daily reminder, starting on the day being viewed (usually today).
 *
 * The row is never deleted when the user removes it — see [id].delete.ts —
 * which is what lets past days keep showing a checkbox for something they
 * stopped tracking later.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const name = assertText(body.name, 'name', 60)

  const db = useDb()
  const { next } = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM reminders WHERE user_id = ?')
    .get(user.id) as { next: number }

  const info = db
    .prepare(
      'INSERT INTO reminders (user_id, name, created_on, sort_order) VALUES (?, ?, ?, ?)',
    )
    .run(user.id, name, day, next)

  return { id: Number(info.lastInsertRowid) }
})

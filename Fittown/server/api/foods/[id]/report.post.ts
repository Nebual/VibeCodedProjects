import { canReportFood } from '#shared/reported'
import { foodCols } from '../../../utils/foods'

/**
 * Flag a food as inaccurate.
 *
 * Sets `foods.reported_by`, which hides the food from every browse path (search,
 * Frequent, barcode lookup and its own detail page) for everyone except a custom
 * food's owner — see shared/reported.ts. There is deliberately no report count
 * or moderation list: one report hides it, and that is the whole feature.
 *
 * Only foods that can actually be reported (not a USDA Foundation Food, not the
 * viewer's own custom food) accept the action; anything else is a refusal.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'food id')

  const db = useDb()
  const food = db
    .prepare(
      `SELECT ${foodCols()} FROM foods f WHERE f.id = ?`,
    )
    .get(id) as
    | { id: number; source: string; owner_user_id: number | null; reported_by: number | null }
    | undefined

  if (!food) throw createError({ statusCode: 404, statusMessage: 'Food not found' })
  if (!canReportFood(food, user.id)) {
    throw createError({ statusCode: 400, statusMessage: 'This food cannot be reported' })
  }

  // Reporting an already-reported food keeps it hidden and lets the most recent
  // reporter undo it. Harmless no-op when unchanged.
  if (food.reported_by !== user.id) {
    db.prepare('UPDATE foods SET reported_by = ? WHERE id = ?').run(user.id, id)
  }

  return { reported_by: user.id }
})
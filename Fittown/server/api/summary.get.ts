import { summarise } from '../utils/summary'

/**
 * Per-day rollups over a date range, for the trends screen.
 *
 * The arithmetic lives in `server/utils/summary.ts` so a friend's trends
 * (`/api/friends/[id]/summary`) draw from exactly the same query.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { from, to } = getQuery(event)

  const start = assertDate(from, 'from')
  const end = assertDate(to, 'to')
  if (start > end) {
    throw createError({ statusCode: 400, statusMessage: '`from` must be on or before `to`' })
  }

  return summarise(useDb(), user.id, start, end, 'full')
})

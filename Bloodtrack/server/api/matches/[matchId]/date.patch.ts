import { findMatch, updateMatchDate } from '../../../utils/db'

/**
 * PATCH /api/matches/:matchId/date  { date: 'YYYY-MM-DD' | null }
 * Sets (or clears) a match's scheduled date WITHOUT touching its report.
 */
export default defineEventHandler(async (event) => {
  const matchId = getRouterParam(event, 'matchId')
  const body = await readBody<{ date?: string | null }>(event)

  const found = findMatch(matchId!)
  if (!found) {
    throw createError({ statusCode: 404, statusMessage: 'Match not found' })
  }

  if (body?.date === undefined || body.date === null || body.date === '') {
    updateMatchDate(found.match.id, null)
    return { ok: true, matchId: found.match.id, date: undefined }
  }
  if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    throw createError({ statusCode: 400, statusMessage: 'date must be YYYY-MM-DD' })
  }
  updateMatchDate(found.match.id, body.date)
  return { ok: true, matchId: found.match.id, date: body.date }
})

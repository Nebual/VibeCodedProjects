import { findMatch, updateMatchDate } from '../../../utils/db'

/**
 * PATCH /api/matches/:matchId/date  { date: 'YYYY-MM-DD' | null, requesterId? }
 * Sets (or clears) a match's scheduled date WITHOUT touching its report.
 * Same authorization convention as the report endpoint: a match participant
 * or the league admin ('__admin__').
 */
export default defineEventHandler(async (event) => {
  const matchId = getRouterParam(event, 'matchId')
  const body = await readBody<{ date?: string | null; requesterId?: string }>(event)

  const found = findMatch(matchId!)
  if (!found) {
    throw createError({ statusCode: 404, statusMessage: 'Match not found' })
  }

  const requesterId = body?.requesterId
  const isParticipant =
    requesterId === found.match.playerAId || requesterId === found.match.playerBId
  if (requesterId !== '__admin__' && !isParticipant) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only match participants or the league admin can set the date',
    })
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

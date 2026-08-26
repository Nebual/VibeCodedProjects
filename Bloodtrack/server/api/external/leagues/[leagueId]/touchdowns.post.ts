/**
 * External touchdown adjustment API.
 *
 * POST /api/external/leagues/:leagueId/touchdowns
 *   { "player": "A" | "B" | "<playerId>", "op": "inc" | "dec" | "set", "amount"?: number }
 *
 * Targets the CURRENT match: the one scheduled for today's date (one match per
 * day is assumed for this endpoint). If no report exists yet, one is created
 * with zeros (result DRAW until a player files a full report).
 */
import type { League, Match, Report } from '~~/shared/types'
import { findCurrentMatch } from '~~/shared/matches'
import { getLeague, saveLeague } from '../../../../utils/db'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default defineEventHandler(async (event) => {
  const leagueId = getRouterParam(event, 'leagueId')
  const body = await readBody<{
    player?: string
    op?: string
    amount?: number
    date?: string
  }>(event)

  if (!body?.op || !['inc', 'dec', 'set'].includes(body.op)) {
    throw createError({ statusCode: 400, statusMessage: 'op must be inc | dec | set' })
  }
  const op = body.op as 'inc' | 'dec' | 'set'
  let amount = body.amount === undefined ? 1 : Number(body.amount)
  if (!Number.isInteger(amount) || amount < 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'amount must be a non-negative integer (default 1)',
    })
  }

  const league = getLeague(leagueId!)
  if (!league) {
    throw createError({ statusCode: 404, statusMessage: 'League not found' })
  }

  // allow overriding "today" for testing / backfilling
  const today = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ? body.date
    : todayISO()

  const match = findCurrentMatch(league, today)
  if (!match) {
    throw createError({
      statusCode: 404,
      statusMessage: `No match scheduled for ${today} in this league`,
    })
  }

  // resolve which side to adjust
  let side: 'A' | 'B'
  if (body.player === 'A') side = 'A'
  else if (body.player === 'B') side = 'B'
  else if (body.player === match.playerAId) side = 'A'
  else if (body.player === match.playerBId) side = 'B'
  else {
    throw createError({
      statusCode: 400,
      statusMessage: 'player must be A, B or a participant id of the current match',
    })
  }

  if (!match.reported) {
    match.reported = {
      reporterId: 'external-api',
      result: 'DRAW',
      touchdownsA: 0,
      touchdownsB: 0,
      casualtiesA: 0,
      casualtiesB: 0,
    }
  }
  const r = match.reported
  const current = side === 'A' ? r.touchdownsA : r.touchdownsB
  let next: number
  if (op === 'inc') next = current + amount
  else if (op === 'dec') next = Math.max(0, current - amount)
  else next = amount

  if (next > 999) {
    throw createError({ statusCode: 400, statusMessage: 'Touchdown count too large' })
  }
  if (side === 'A') r.touchdownsA = next
  else r.touchdownsB = next

  saveLeague(league)
  return {
    ok: true,
    date: today,
    matchId: match.id,
    touchdownsA: r.touchdownsA,
    touchdownsB: r.touchdownsB,
  }
})

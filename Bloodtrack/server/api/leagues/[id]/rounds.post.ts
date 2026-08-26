import { randomUUID } from 'node:crypto'
import { pairRound } from '~~/shared/scoring'
import type { Match } from '~~/shared/types'
import { getLeague, saveLeague } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const leagueId = getRouterParam(event, 'id')
  const body = await readBody<{ date?: string }>(event).catch(() => ({}) as { date?: string })
  const league = getLeague(leagueId!)
  if (!league) {
    throw createError({ statusCode: 404, statusMessage: 'League not found' })
  }
  const pairedIds = new Set(league.matches.map((m) => [m.playerAId, m.playerBId]).flat())
  const roundNumber =
    league.matches.length === 0 ? 1 : Math.max(...league.matches.map((m) => m.round)) + 1
  const pairings = pairRound(league.players, pairedIds)
  for (const p of pairings) {
    if (p.a.id === p.b.id) continue // lone bye player, no match recorded
    const match: Match = {
      id: randomUUID(),
      round: roundNumber,
      playerAId: p.a.id,
      playerBId: p.b.id,
    }
    // optional default date for this round (one match per day assumed by the
    // external TD endpoint; admin can set individual dates per match later)
    if (typeof body?.date === 'string' && body.date) match.date = body.date
    league.matches.push(match)
  }
  saveLeague(league)
  return { round: roundNumber, matches: league.matches.filter((m) => m.round === roundNumber) }
})

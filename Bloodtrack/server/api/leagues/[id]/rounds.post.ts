import { randomUUID } from 'node:crypto'
import { generateRoundRobin } from '~~/shared/scoring'
import type { Match } from '~~/shared/types'
import { getLeague, saveLeague } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const leagueId = getRouterParam(event, 'id')
  const body = await readBody<{ startDate?: string; daysPerRound?: number }>(event).catch(
    () => ({}) as { startDate?: string; daysPerRound?: number },
  )
  const league = getLeague(leagueId!)
  if (!league) {
    throw createError({ statusCode: 404, statusMessage: 'League not found' })
  }

  // matchups already scheduled (either direction)
  const existing = new Set(
    league.matches.flatMap((m) => [
      `${m.playerAId}|${m.playerBId}`,
      `${m.playerBId}|${m.playerAId}`,
    ]),
  )

  // full round-robin: N-1 rounds (or N with a ghost for odd counts),
  // every player meets every other exactly once
  const allRounds = generateRoundRobin(league.players)
  const nextRoundNumber =
    league.matches.length === 0 ? 1 : Math.max(...league.matches.map((m) => m.round)) + 1

  const created: Match[] = []
  let roundNo = nextRoundNumber

  // optional date scheduling: round r starts at startDate + r*daysPerRound
  const startMs = body?.startDate ? Date.parse(`${body.startDate}T00:00:00Z`) : NaN
  const daysPerRound = Number.isInteger(body?.daysPerRound) && body.daysPerRound! > 0 ? body.daysPerRound! : 14
  const hasDates = !Number.isNaN(startMs)

  for (const pairings of allRounds) {
    const roundDate = hasDates
      ? new Date(startMs + Math.round(((roundNo - nextRoundNumber) * daysPerRound * 86400000)))
        .toISOString()
        .slice(0, 10)
      : undefined
    let anyMatchInRound = false
    for (const p of pairings) {
      if (p.bye || p.a.id === p.b.id) continue // bye, no match recorded
      const key = `${p.a.id}|${p.b.id}`
      const keyRev = `${p.b.id}|${p.a.id}`
      if (existing.has(key) || existing.has(keyRev)) continue // no duplicate matchups
      const match: Match = {
        id: randomUUID(),
        round: roundNo,
        playerAId: p.a.id,
        playerBId: p.b.id,
        ...(roundDate ? { date: roundDate } : {}),
      }
      league.matches.push(match)
      created.push(match)
      existing.add(key)
      anyMatchInRound = true
    }
    if (anyMatchInRound) roundNo++
  }

  saveLeague(league)
  return {
    createdRounds: roundNo - nextRoundNumber,
    createdMatches: created.length,
    matches: created,
  }
})

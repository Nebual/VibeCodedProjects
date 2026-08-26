import { getLeague, listLeagues, saveLeague } from '../../../utils/db'
import type { League } from '~~/shared/types'
import type { Report } from '~~/shared/types'

function nonNegInt(v: unknown): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw createError({ statusCode: 400, statusMessage: 'Values must be integers 0-99' })
  }
  return n
}

export default defineEventHandler(async (event) => {
  const matchId = getRouterParam(event, 'matchId')
  const body = await readBody<{
    reporterId?: string
    result?: string
    touchdownsA?: number
    touchdownsB?: number
    casualtiesA?: number
    casualtiesB?: number
    date?: string
  }>(event)

  let league: League | undefined
  for (const l of listLeagues()) {
    const full = getLeague(l.id)
    if (full?.matches.some((m) => m.id === matchId)) {
      league = full
      break
    }
  }
  if (!league) {
    throw createError({ statusCode: 404, statusMessage: 'Match not found' })
  }
  const match = league.matches.find((m) => m.id === matchId)!
  const overwroteExisting = !!match.reported

  const reporterId = body?.reporterId
  // '__admin__' is the league admin, who may report any match
  if (reporterId === '__admin__') {
    // ok
  } else if (!reporterId || !league.players.some((p) => p.id === reporterId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown reporter' })
  } else if (reporterId !== match.playerAId && reporterId !== match.playerBId) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Reporter must be a participant in this match',
    })
  }
  const result = body?.result
  if (result !== 'A_WIN' && result !== 'B_WIN' && result !== 'DRAW') {
    throw createError({ statusCode: 400, statusMessage: 'Invalid result' })
  }
  if (body?.date !== undefined && body.date !== null) {
    if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw createError({ statusCode: 400, statusMessage: 'date must be YYYY-MM-DD' })
    }
    match.date = body.date
  }

  const report: Report = {
    reporterId,
    result,
    touchdownsA: nonNegInt(body?.touchdownsA ?? 0),
    touchdownsB: nonNegInt(body?.touchdownsB ?? 0),
    casualtiesA: nonNegInt(body?.casualtiesA ?? 0),
    casualtiesB: nonNegInt(body?.casualtiesB ?? 0),
  }
  match.reported = report
  saveLeague(league)

  return { ok: true, overwroteExisting, match }
})

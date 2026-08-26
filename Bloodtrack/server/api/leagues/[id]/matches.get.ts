import { getLeague } from '../../../utils/db'
import { listRoundMatches } from '~~/shared/matches'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  const query = getQuery(event)
  const round =
    query.round === undefined || query.round === ''
      ? undefined
      : Number.parseInt(String(query.round), 10)
  if (round !== undefined && !Number.isInteger(round)) {
    throw createError({ statusCode: 400, statusMessage: 'round must be an integer' })
  }
  const league = getLeague(id!)
  if (!league) {
    throw createError({ statusCode: 404, statusMessage: 'League not found' })
  }
  return { leagueId: league.id, leagueName: league.name, matches: listRoundMatches(league, round) }
})

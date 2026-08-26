import { addPlayer, getLeague, saveLeague } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const leagueId = getRouterParam(event, 'id')
  const body = await readBody<{ name?: string }>(event)
  const name = body?.name?.trim()
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Player name is required' })
  }
  const league = getLeague(leagueId!)
  if (!league) {
    throw createError({ statusCode: 404, statusMessage: 'League not found' })
  }
  return addPlayer(leagueId!, name)
})

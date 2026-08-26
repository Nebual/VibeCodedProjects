import { getLeague, saveLeague } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const leagueId = getRouterParam(event, 'id')
  const playerId = getRouterParam(event, 'playerId')
  const body = await readBody<{ name?: string; requesterId?: string }>(event)

  const league = getLeague(leagueId!)
  if (!league) {
    throw createError({ statusCode: 404, statusMessage: 'League not found' })
  }
  const player = league.players.find((p) => p.id === playerId)
  if (!player) {
    throw createError({ statusCode: 404, statusMessage: 'Player not found' })
  }

  const name = body?.name?.trim()
  if (!name || name.length > 60) {
    throw createError({ statusCode: 400, statusMessage: 'Name must be 1-60 characters' })
  }

  // a player may only rename themselves; the league admin ('__admin__') may
  // rename anyone
  const requesterId = body?.requesterId ?? playerId
  if (requesterId !== playerId && requesterId !== '__admin__') {
    throw createError({
      statusCode: 403,
      statusMessage: 'You can only change your own name',
    })
  }

  player.name = name
  saveLeague(league)
  return { ok: true, player }
})

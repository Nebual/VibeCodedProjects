import { getLeague } from '../../../utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  const league = getLeague(id!)
  if (!league) {
    throw createError({ statusCode: 404, statusMessage: 'League not found' })
  }
  return league
})

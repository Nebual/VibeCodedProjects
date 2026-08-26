import { createLeague } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string }>(event)
  const name = body?.name?.trim()
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'League name is required' })
  }
  return createLeague(name)
})

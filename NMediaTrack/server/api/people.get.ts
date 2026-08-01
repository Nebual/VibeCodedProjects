import { listPeople } from '~~/server/utils/mediaStore'

// GET /api/people?not=Name — known names, for tag autocomplete.
export default defineEventHandler(async (event) => {
  const { not } = getQuery(event)
  return { people: await listPeople(typeof not === 'string' ? not : '') }
})

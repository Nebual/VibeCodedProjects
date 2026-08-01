import { visibleMediaFor } from '~~/server/utils/mediaStore'

// GET /api/media?user=Name
// Own list + the full lists of anyone who has tagged this user.
export default defineEventHandler(async (event) => {
  const { user } = getQuery(event)
  const name = typeof user === 'string' ? user.trim() : ''
  if (!name) return { items: [], me: '' }

  const items = (await visibleMediaFor(name)).sort((a, b) => {
    // Most recent activity first; items without activity fall back to createdAt.
    const at = a.lastActivityAt || a.createdAt
    const bt = b.lastActivityAt || b.createdAt
    return bt.localeCompare(at)
  })
  return { items, me: name }
})

import { findItem, mutateUserMedia } from '~~/server/utils/mediaStore'
import { canDeleteItem } from '~~/shared/types'

// DELETE /api/media/:id?actor=Name
// Owner-only. Tagged friends can edit an item but not remove it from the
// owner's list — that stays the owner's call.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const { actor } = getQuery(event)
  const name = typeof actor === 'string' ? actor.trim() : ''
  if (!name) throw createError({ statusCode: 400, statusMessage: 'actor is required' })

  const found = await findItem(id)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'Media not found' })
  if (!canDeleteItem(found.item, name)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only the owner can delete this item',
    })
  }

  return await mutateUserMedia(found.ownerKey, (media) => ({
    result: { ok: true, id },
    media: media.filter((m) => m.id !== id),
  }))
})

import { canonical, findItemOwner, mutateUserMedia } from '~~/server/utils/mediaStore'

// DELETE /api/media/:id?actor=Name  — only the owner may delete.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const { actor } = getQuery(event)
  const name = typeof actor === 'string' ? actor.trim() : ''
  if (!name) throw createError({ statusCode: 400, statusMessage: 'actor is required' })

  const ownerKey = await findItemOwner(id)
  if (!ownerKey) throw createError({ statusCode: 404, statusMessage: 'Media not found' })
  if (ownerKey !== canonical(name)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only the owner can delete this item',
    })
  }

  return await mutateUserMedia(name, (media) => ({
    result: { ok: true, id },
    media: media.filter((m) => m.id !== id),
  }))
})

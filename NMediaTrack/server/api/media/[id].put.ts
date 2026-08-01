import { canonical, findItemOwner, mutateUserMedia } from '~~/server/utils/mediaStore'
import { MEDIA_STATUSES, MEDIA_TYPES } from '~~/shared/types'
import type { MediaItem, MediaUpdateInput } from '~~/shared/types'

// PUT /api/media/:id  — update an item. Only the owner (body.actor) may edit.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const body = await readBody<MediaUpdateInput>(event)
  const actor = String(body?.actor ?? '').trim()
  if (!actor) throw createError({ statusCode: 400, statusMessage: 'actor is required' })

  const ownerKey = await findItemOwner(id)
  if (!ownerKey) throw createError({ statusCode: 404, statusMessage: 'Media not found' })
  if (ownerKey !== canonical(actor)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only the owner can edit this item',
    })
  }

  return await mutateUserMedia(actor, (media) => {
    const idx = media.findIndex((m) => m.id === id)
    if (idx === -1) throw createError({ statusCode: 404, statusMessage: 'Media not found' })

    const existing = media[idx]!
    const now = new Date().toISOString()
    const updated: MediaItem = { ...existing, updatedAt: now }

    if (typeof body.title === 'string') updated.title = body.title.trim()
    if (body.type && MEDIA_TYPES.includes(body.type)) updated.type = body.type
    if (body.status && MEDIA_STATUSES.includes(body.status)) updated.status = body.status
    if (Array.isArray(body.companions)) {
      updated.companions = [
        ...new Set(body.companions.map((c) => String(c).trim()).filter(Boolean)),
      ]
    }
    if ('lastEpisode' in body) {
      updated.lastEpisode = body.lastEpisode ? String(body.lastEpisode).trim() : undefined
    }
    if ('notes' in body) {
      updated.notes = body.notes ? String(body.notes).trim() : undefined
    }
    if ('lastActivityAt' in body && body.lastActivityAt) {
      updated.lastActivityAt = String(body.lastActivityAt)
    }
    if ('review' in body) {
      if (body.review === null) {
        updated.review = undefined
      } else if (body.review && Number(body.review.stars) > 0) {
        updated.review = {
          stars: Math.min(5, Math.max(1, Number(body.review.stars))),
          message: String(body.review.message ?? '').trim(),
          updatedAt: now,
        }
      }
    }

    const next = [...media]
    next[idx] = updated
    return { result: { item: updated }, media: next }
  })
})

import { canonical, findItemOwner, mutateUserMedia } from '~~/server/utils/mediaStore'
import { MEDIA_STATUSES, MEDIA_TYPES, normaliseGroupSize } from '~~/shared/types'
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
    // Explicit null clears the date; omitting the key leaves it untouched.
    if ('lastActivityAt' in body) {
      updated.lastActivityAt = body.lastActivityAt
        ? String(body.lastActivityAt)
        : undefined
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
    if ('minPlayers' in body) updated.minPlayers = body.minPlayers ?? undefined
    if ('soloable' in body) updated.soloable = body.soloable ?? undefined

    // Re-validate against the FINAL companion list: shrinking the group can
    // invalidate a minimum the client never touched.
    const group = normaliseGroupSize(
      updated.companions.length,
      updated.minPlayers,
      updated.soloable,
    )
    updated.minPlayers = group.minPlayers
    updated.soloable = group.soloable

    const next = [...media]
    next[idx] = updated
    return { result: { item: updated }, media: next }
  })
})

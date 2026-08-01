import { findItem, mutateUserMedia } from '~~/server/utils/mediaStore'
import {
  canEditItem,
  canonicalName,
  MEDIA_STATUSES,
  MEDIA_TYPES,
  normaliseGroupSize,
} from '~~/shared/types'
import type { MediaItem, MediaUpdateInput, Review } from '~~/shared/types'

// PUT /api/media/:id
// The owner and anyone tagged on the item may edit it. A `review` in the body
// always applies to the actor's OWN review — you can never touch someone else's.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const body = await readBody<MediaUpdateInput>(event)
  const actor = String(body?.actor ?? '').trim()
  if (!actor) throw createError({ statusCode: 400, statusMessage: 'actor is required' })

  const found = await findItem(id)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'Media not found' })
  if (!canEditItem(found.item, actor)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only the owner or someone tagged on this item can edit it',
    })
  }

  // Edits land in the owner's file even when a tagged friend made them.
  return await mutateUserMedia(found.ownerKey, (media) => {
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

    // Reviews are per-person: this only ever adds, replaces or removes the
    // actor's own entry, leaving everyone else's alone.
    if ('review' in body) {
      const mine = canonicalName(actor)
      const others = existing.reviews.filter((r) => canonicalName(r.author) !== mine)
      if (body.review === null || !body.review || Number(body.review.stars) <= 0) {
        updated.reviews = others
      } else {
        const review: Review = {
          author: actor,
          stars: Math.min(5, Math.max(1, Number(body.review.stars))),
          message: String(body.review.message ?? '').trim(),
          updatedAt: now,
        }
        updated.reviews = [...others, review]
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

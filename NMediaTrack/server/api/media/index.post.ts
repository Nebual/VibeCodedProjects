import { mutateUserMedia, newId } from '~~/server/utils/mediaStore'
import { MEDIA_STATUSES, MEDIA_TYPES, normaliseGroupSize } from '~~/shared/types'
import type { MediaCreateInput, MediaItem } from '~~/shared/types'

// POST /api/media  — create an entry in body.owner's own list.
export default defineEventHandler(async (event) => {
  const body = await readBody<MediaCreateInput>(event)

  const owner = String(body?.owner ?? '').trim()
  const title = String(body?.title ?? '').trim()
  if (!owner) throw createError({ statusCode: 400, statusMessage: 'owner is required' })
  if (!title) throw createError({ statusCode: 400, statusMessage: 'title is required' })

  const type = MEDIA_TYPES.includes(body.type) ? body.type : 'other'
  const status = MEDIA_STATUSES.includes(body.status as never)
    ? (body.status as MediaItem['status'])
    : 'backlog'

  const now = new Date().toISOString()
  const companions = Array.isArray(body.companions)
    ? [...new Set(body.companions.map((c) => String(c).trim()).filter(Boolean))]
    : []
  const group = normaliseGroupSize(companions.length, body.minPlayers, body.soloable)

  const item: MediaItem = {
    id: newId(),
    title,
    type,
    owner,
    status,
    companions,
    lastEpisode: body.lastEpisode ? String(body.lastEpisode).trim() : undefined,
    lastActivityAt: body.lastActivityAt || (status === 'active' ? now : undefined),
    minPlayers: group.minPlayers,
    soloable: group.soloable,
    createdAt: now,
    updatedAt: now,
    notes: body.notes ? String(body.notes).trim() : undefined,
    review:
      body.review && Number(body.review.stars) > 0
        ? {
            stars: Math.min(5, Math.max(1, Number(body.review.stars))),
            message: String(body.review.message ?? '').trim(),
            updatedAt: now,
          }
        : undefined,
  }

  await mutateUserMedia(owner, (media) => ({ result: item, media: [...media, item] }))
  return { item }
})

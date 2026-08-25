import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../../database/client'
import { takes } from '../../../database/schema'
import type { EditList } from '#shared/types'
import type { ResolvedSegment } from '#shared/utils/timeline'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

  const body = await readBody<{ editList: EditList, audition?: boolean, baseSegments?: ResolvedSegment[] }>(event)
  const editList = body?.editList
  if (!editList?.segments?.length) {
    throw createError({ statusCode: 400, statusMessage: 'Edit list has no segments' })
  }

  const songTakes = db.select().from(takes).where(eq(takes.songId, songId)).all()
  const validIds = new Set(songTakes.map(t => t.id))
  if (editList.segments.some(s => !validIds.has(s.source))) {
    throw createError({ statusCode: 400, statusMessage: 'Edit list references an unknown take' })
  }
  if (body?.audition && !editList.filters.some(f => f.type === 'afftdn')) {
    throw createError({ statusCode: 400, statusMessage: 'No noise-reduction filter to audition' })
  }

  const sources = songTakes.map(t => ({ id: t.id, path: t.sourcePath }))
  const noiseTrainingSource = body.baseSegments
    ? resolveNoiseTrainingSource(editList.filters, body.baseSegments, sources)
    : undefined
  const previewId = nanoid()
  const outPath = join(rendersDir(), `preview-${songId}-${previewId}.ogg`)
  await renderEditList(sources, editList, outPath, 'ogg', { audition: body?.audition, noiseTrainingSource })

  return { url: `/api/songs/${songId}/preview/${previewId}` }
})

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../../database/client'
import { takes } from '../../../database/schema'
import { segmentsDuration } from '#shared/utils/timeline'
import type { ResolvedSegment } from '#shared/utils/timeline'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

  const body = await readBody<{ segments: ResolvedSegment[] }>(event)
  const segments = body?.segments
  if (!segments?.length) {
    throw createError({ statusCode: 400, statusMessage: 'No segments to analyze' })
  }

  const songTakes = db.select().from(takes).where(eq(takes.songId, songId)).all()
  const validIds = new Set(songTakes.map(t => t.id))
  if (segments.some(s => !validIds.has(s.source))) {
    throw createError({ statusCode: 400, statusMessage: 'Segment references an unknown take' })
  }

  const sampleRate = 8000
  const totalDuration = segmentsDuration(segments)

  let samples
  if (segments.length === 1) {
    const take = songTakes.find(t => t.id === segments[0]!.source)!
    samples = await decodeMonoPcm16Window(take.sourcePath, sampleRate, segments[0]!.start, segments[0]!.end - segments[0]!.start)
  } else {
    const sources = songTakes.map(t => ({ id: t.id, path: t.sourcePath }))
    const tmpPath = join(rendersDir(), `autotrim-${songId}-${nanoid()}.ogg`)
    await renderEditList(sources, { segments, filters: [] }, tmpPath, 'ogg')
    try {
      samples = await decodeMonoPcm16(tmpPath, sampleRate)
    } finally {
      await rm(tmpPath, { force: true })
    }
  }

  const proposal = analyzeAutoTrim(samples, totalDuration)
  return proposal
})

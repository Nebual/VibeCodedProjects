import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { takes } from '../../../database/schema'
import { resolveSegmentPosition } from '#shared/utils/timeline'
import type { NoiseRegion } from '#shared/types'
import type { ResolvedSegment } from '#shared/utils/timeline'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  const body = await readBody<{ segments: ResolvedSegment[], region?: NoiseRegion }>(event).catch(() => null)
  const segments = body?.segments
  const region = body?.region ?? song.noiseRegion
  if (!segments?.length) {
    throw createError({ statusCode: 400, statusMessage: 'No segments to analyze' })
  }
  if (!region || region.end <= region.start) {
    throw createError({ statusCode: 400, statusMessage: 'No noise region to analyze' })
  }

  const songTakes = db.select().from(takes).where(eq(takes.songId, songId)).all()
  const validIds = new Set(songTakes.map(t => t.id))
  if (segments.some(s => !validIds.has(s.source))) {
    throw createError({ statusCode: 400, statusMessage: 'Segment references an unknown take' })
  }

  const resolved = resolveSegmentPosition(segments, region.start)
  if (!resolved) {
    throw createError({ statusCode: 400, statusMessage: 'Noise region is outside the current segments' })
  }
  const take = songTakes.find(t => t.id === resolved.source)!

  const sampleRate = 8000
  const samples = await decodeMonoPcm16Window(take.sourcePath, sampleRate, resolved.localTime, region.end - region.start)
  const frequencies = detectNoiseTones(samples, sampleRate)

  return { frequencies }
})

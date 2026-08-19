import type { NoiseRegion } from '#shared/types'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  if (!song.masterPath) {
    throw createError({ statusCode: 404, statusMessage: 'Audio is still processing' })
  }

  const body = await readBody<{ region?: NoiseRegion }>(event).catch(() => null)
  const region = body?.region ?? song.noiseRegion
  if (!region || region.end <= region.start) {
    throw createError({ statusCode: 400, statusMessage: 'No noise region to analyze' })
  }

  const sampleRate = 8000
  const samples = await decodeMonoPcm16Window(song.masterPath, sampleRate, region.start, region.end - region.start)
  const frequencies = detectNoiseTones(samples, sampleRate)

  return { frequencies }
})

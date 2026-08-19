export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  if (!song.masterPath || !song.durationS) {
    throw createError({ statusCode: 404, statusMessage: 'Audio is still processing' })
  }

  const samples = await decodeMonoPcm16(song.masterPath, 8000)
  const proposal = analyzeAutoTrim(samples, song.durationS)

  return proposal
})

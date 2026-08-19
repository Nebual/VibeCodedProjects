export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  if (!song.masterPath) {
    throw createError({ statusCode: 404, statusMessage: 'Audio is still processing' })
  }

  return streamRangeableFile(event, song.masterPath, 'audio/ogg')
})

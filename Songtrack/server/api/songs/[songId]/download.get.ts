export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  const format = getQuery(event).format === 'mp3' ? 'mp3' : 'ogg'
  const path = await getOrRenderDownload(song, format)

  setHeader(event, 'Content-Disposition', `attachment; filename="${slugify(song.title)}.${format}"`)
  return streamRangeableFile(event, path, format === 'mp3' ? 'audio/mpeg' : 'audio/ogg')
})

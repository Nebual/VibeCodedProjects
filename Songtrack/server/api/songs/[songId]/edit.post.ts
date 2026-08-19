import { writeFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { songs, takes } from '../../../database/schema'
import type { EditList } from '#shared/types'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  if (!song.masterPath || !song.peaksPath) {
    throw createError({ statusCode: 404, statusMessage: 'Audio is still processing' })
  }

  const body = await readBody<{ editList: EditList }>(event)
  const editList = body?.editList
  if (!editList?.segments?.length) {
    throw createError({ statusCode: 400, statusMessage: 'Edit list has no segments' })
  }

  const songTakes = db.select().from(takes).where(eq(takes.songId, songId)).all()
  const validIds = new Set(songTakes.map(t => t.id))
  if (editList.segments.some(s => !validIds.has(s.source))) {
    throw createError({ statusCode: 400, statusMessage: 'Edit list references an unknown take' })
  }

  const sources = songTakes.map(t => ({ id: t.id, path: t.sourcePath }))
  await renderEditList(sources, editList, song.masterPath, 'ogg')

  const [probe, peaks] = await Promise.all([
    ffprobe(song.masterPath),
    generatePeaks(song.masterPath),
  ])
  await writeFile(song.peaksPath, JSON.stringify(peaks))

  db.update(songs).set({
    editList,
    durationS: probe.durationS,
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    updatedAt: new Date(),
  }).where(eq(songs.id, songId)).run()

  recordAuditIfImpersonating(actor, 'song.edit', songId)
  return { ok: true, durationS: probe.durationS }
})

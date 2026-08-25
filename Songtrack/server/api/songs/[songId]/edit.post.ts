import { writeFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { songs, takes } from '../../../database/schema'
import type { EditList, EditSettings, NoiseRegion } from '#shared/types'
import type { ResolvedSegment } from '#shared/utils/timeline'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  if (!song.masterPath || !song.peaksPath) {
    throw createError({ statusCode: 404, statusMessage: 'Audio is still processing' })
  }

  const body = await readBody<{
    editList: EditList
    noiseRegion?: NoiseRegion | null
    editSettings?: EditSettings | null
    baseSegments?: ResolvedSegment[]
  }>(event)
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
  const noiseTrainingSource = body.baseSegments
    ? resolveNoiseTrainingSource(editList.filters, body.baseSegments, sources)
    : undefined
  await renderEditList(sources, editList, song.masterPath, 'ogg', { noiseTrainingSource })

  const [probe, peaks] = await Promise.all([
    ffprobe(song.masterPath),
    generatePeaks(song.masterPath),
  ])
  await writeFile(song.peaksPath, JSON.stringify(peaks))

  db.update(songs).set({
    editList,
    editSettings: body?.editSettings ?? null,
    noiseRegion: body?.noiseRegion ?? null,
    durationS: probe.durationS,
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    updatedAt: new Date(),
  }).where(eq(songs.id, songId)).run()

  recordAuditIfImpersonating(actor, 'song.edit', songId)
  return { ok: true, durationS: probe.durationS }
})

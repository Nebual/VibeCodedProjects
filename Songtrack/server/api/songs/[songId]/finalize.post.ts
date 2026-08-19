import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { songs, takes } from '../../../database/schema'
import type { EditList } from '#shared/types'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

  const songTakes = db.select().from(takes).where(eq(takes.songId, songId)).orderBy(asc(takes.ordinal)).all()
  if (songTakes.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No takes uploaded for this song' })
  }

  const timelineTakes = songTakes.map(t => ({ id: t.id, timelineStart: t.timelineStart, duration: t.durationS ?? 0 }))
  const segments = resolveTimeline(timelineTakes)

  const editList: EditList = { segments, filters: [] }
  const dir = songDir(actor.user.id, songId)
  const masterPath = join(dir, 'master.ogg')
  const peaksPath = join(dir, 'peaks.json')

  const sources = songTakes.map(t => ({ id: t.id, path: t.sourcePath }))
  await renderEditList(sources, editList, masterPath, 'ogg')

  const [probe, peaks] = await Promise.all([
    ffprobe(masterPath),
    generatePeaks(masterPath),
  ])
  await writeFile(peaksPath, JSON.stringify(peaks))

  db.update(songs).set({
    masterPath,
    peaksPath,
    editList,
    durationS: probe.durationS,
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    updatedAt: new Date(),
  }).where(eq(songs.id, songId)).run()

  recordAuditIfImpersonating(actor, 'song.finalize', songId)

  return { id: songId, durationS: probe.durationS }
})

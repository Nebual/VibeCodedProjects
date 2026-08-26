import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from '../../../../../database/client'
import { takes } from '../../../../../database/schema'

// Covers both MediaRecorder output (ogg/webm) and user-uploaded files (mp3, m4a, flac,
// wav, opus, aac) — browser-reported MIME strings vary (`x-m4a`, `codecs=` suffixes).
function extFromMime(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('webm')) return 'webm'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('m4a') || m.includes('mp4') || m.includes('aac')) return 'm4a'
  if (m.includes('flac')) return 'flac'
  if (m.includes('wav')) return 'wav'
  return 'bin'
}

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const takeId = getRouterParam(event, 'takeId')!
  getOwnedSong(actor.user.id, songId)

  const body = await readBody<{ timelineStart: number, ordinal: number, mimeType: string, duration: number }>(event)

  const chunkDir = takeChunkDir(actor.user.id, songId, takeId)
  const files = (await readdir(chunkDir)).filter(f => f.endsWith('.chunk')).sort()
  if (files.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No chunks uploaded for this take' })
  }

  const finalPath = takeFinalPath(actor.user.id, songId, takeId, extFromMime(body.mimeType))
  await mkdir(join(finalPath, '..'), { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(finalPath)
    out.on('error', reject)
    out.on('finish', resolve)
    void (async () => {
      for (const f of files) {
        const buf = await readFile(join(chunkDir, f))
        if (!out.write(buf)) {
          await new Promise(r => out.once('drain', r))
        }
      }
      out.end()
    })().catch(reject)
  })

  await rm(chunkDir, { recursive: true, force: true })

  const probe = await ffprobe(finalPath)

  db.insert(takes).values({
    id: takeId,
    songId,
    sourcePath: finalPath,
    timelineStart: body.timelineStart,
    durationS: body.duration || probe.durationS,
    ordinal: body.ordinal,
    createdAt: new Date(),
  }).run()

  return { ok: true }
})

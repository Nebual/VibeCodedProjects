import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../database/client'
import { songs, takes } from '../../database/schema'
import { ffprobe, generatePeaks, renderEditList } from '../../utils/ffmpeg'
import { songDir } from '../../utils/paths'
import type { EditList } from '#shared/types'

/**
 * Upload of a complete audio file (mp3/ogg/m4a/…) as a new song's single take.
 *
 * The whole request body IS the file (raw bytes, like the chunk endpoint — no multipart
 * parsing needed). Metadata rides along as query params, keeping the client trivially
 * simple: one POST per file, streamed to disk without ever buffering it whole in memory.
 *
 * Rendering (master.ogg + peaks) happens inline before responding so the returned song id
 * is fully playable by the time the client navigates to it. For large uploads that makes
 * each response slow, but uploads are queued client-side and strictly sequential anyway,
 * and it avoids any background-job machinery.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  assertCanCreateSong(actor.user)

  const q = getQuery(event)
  const title = typeof q.title === 'string' ? q.title.trim() : ''
  if (!title) {
    throw createError({ statusCode: 400, statusMessage: 'Title is required' })
  }

  const mimeType = typeof q.mime === 'string' ? q.mime : ''
  const filename = typeof q.filename === 'string' ? q.filename : ''

  const songId = nanoid()
  const takeId = nanoid()
  const dir = songDir(actor.user.id, songId)

  const ext = guessUploadExt(filename) || guessExtFromMime(mimeType)
  if (!ext || ext === 'bin') {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported audio file type' })
  }
  const takePath = join(dir, 'takes', `${takeId}.${ext}`)

  await mkdir(join(takePath, '..'), { recursive: true })
  await streamRequestBodyToFile(event.node.req, takePath)

  const probe = await ffprobe(takePath).catch(() => null)
  if (!probe || !probe.durationS) {
    throw createError({ statusCode: 400, statusMessage: 'Not a readable audio file' })
  }

  const now = new Date()
  db.insert(songs).values({
    id: songId,
    userId: actor.user.id,
    title,
    slug: slugify(title),
    editList: { segments: [], filters: [] },
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(takes).values({
    id: takeId,
    songId,
    sourcePath: takePath,
    timelineStart: 0,
    durationS: probe.durationS,
    ordinal: 0,
    createdAt: now,
  }).run()

  const editList: EditList = {
    segments: [{ source: takeId, start: 0, end: probe.durationS }],
    filters: [],
  }
  const masterPath = join(dir, 'master.ogg')
  const peaksPath = join(dir, 'peaks.json')

  await renderEditList([{ id: takeId, path: takePath }], editList, masterPath, 'ogg')
  const [masterProbe, peaks] = await Promise.all([ffprobe(masterPath), generatePeaks(masterPath)])
  await writeFile(peaksPath, JSON.stringify(peaks))

  db.update(songs).set({
    masterPath,
    peaksPath,
    editList,
    durationS: masterProbe.durationS,
    sampleRate: masterProbe.sampleRate,
    channels: masterProbe.channels,
    updatedAt: new Date(),
  }).where(eq(songs.id, songId)).run()

  recordAuditIfImpersonating(actor, 'song.upload', songId)

  return { id: songId }
})

function guessExtFromMime(mime: string): string {
  const m = mime.toLowerCase()
  if (!m) return ''
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('webm')) return 'webm'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('m4a') || m.includes('mp4') || m.includes('aac')) return 'm4a'
  if (m.includes('flac')) return 'flac'
  if (m.includes('wav')) return 'wav'
  if (m.includes('opus')) return 'opus'
  return ''
}

const KNOWN_AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'wma', 'opus', 'webm']

/** Extension straight from the filename — more reliable than MIME when we have it. */
function guessUploadExt(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  return KNOWN_AUDIO_EXTS.includes(ext) ? ext : ''
}

async function streamRequestBodyToFile(nodeStream: import('node:http').IncomingMessage, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path)
    out.on('error', reject)
    nodeStream.on('error', reject)
    nodeStream.on('aborted', () => reject(new Error('Upload aborted')))
    out.on('finish', resolve)
    nodeStream.pipe(out)
  })
}

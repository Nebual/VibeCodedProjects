import { mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { allocateSong, createSongFromAudioFile } from '../../utils/songs'

/**
 * Upload of a complete audio file (mp3/ogg/m4a/…) as a new song's single take.
 *
 * The whole request body IS the file (raw bytes, like the chunk endpoint — no multipart
 * parsing needed). Metadata rides along as query params, keeping the client trivially
 * simple: one POST per file, streamed to disk without ever buffering it whole in memory.
 *
 * Once the bytes are on disk, `createSongFromAudioFile` does the rest (probe, insert,
 * render, peaks) — the same tail the YouTube import runs.
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

  const ids = allocateSong(actor.user.id)

  const ext = guessUploadExt(filename) || guessExtFromMime(mimeType)
  if (!ext || ext === 'bin') {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported audio file type' })
  }
  const takePath = join(ids.dir, 'takes', `${ids.takeId}.${ext}`)

  await mkdir(join(takePath, '..'), { recursive: true })
  await streamRequestBodyToFile(event.node.req, takePath)

  const song = await createSongFromAudioFile({ actor, ids, title, takePath, auditAction: 'song.upload' })
  return { id: song.id }
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

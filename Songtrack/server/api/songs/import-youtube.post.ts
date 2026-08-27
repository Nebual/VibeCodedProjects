import { mkdir, rm } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { allocateSong, createSongFromAudioFile } from '../../utils/songs'
import {
  YtDlpFailedError,
  YtDlpMissingError,
  buildYtDlpArgs,
  runYtDlp,
} from '../../utils/ytdlp'
import { normalizeYoutubeUrl } from '../../../shared/utils/youtube'

/**
 * Import a single YouTube video as a new song, via yt-dlp.
 *
 * One URL per request — the client queue posts them one at a time (concurrency 1), the same
 * way it does file uploads, so a paste of twenty links doesn't start twenty downloads and
 * twenty ffmpeg renders at once.
 *
 * Like `upload.post.ts` this is synchronous: the request stays open for the download *and*
 * the render, and comes back with an id that is immediately playable. `MAX_IMPORT_DURATION_S`
 * and yt-dlp's own timeout are what keep that bounded.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  assertCanCreateSong(actor.user)

  const body = await readBody<{ url?: string }>(event)
  const parsed = normalizeYoutubeUrl(typeof body?.url === 'string' ? body.url : '')
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.reason })
  }

  const ids = allocateSong(actor.user.id)
  const takesDir = join(ids.dir, 'takes')
  await mkdir(takesDir, { recursive: true })

  let downloaded: { title: string, filePath: string }
  try {
    downloaded = await runYtDlp(buildYtDlpArgs({
      videoId: parsed.videoId,
      // yt-dlp fills in %(ext)s with whatever container YouTube served (usually webm/opus
      // or m4a) — both are ffmpeg-readable, and the take is re-encoded into master.ogg anyway.
      outputTemplate: join(takesDir, `${ids.takeId}.%(ext)s`),
    }))
  } catch (error) {
    // Nothing is in the database yet, so a failed import should leave no directory behind.
    await rm(ids.dir, { recursive: true, force: true }).catch(() => {})
    if (error instanceof YtDlpMissingError) {
      throw createError({
        statusCode: 503,
        statusMessage: 'YouTube import isn\'t available on this server (yt-dlp is not installed).',
      })
    }
    if (error instanceof YtDlpFailedError) {
      throw createError({ statusCode: 502, statusMessage: error.message })
    }
    throw error
  }

  // yt-dlp reports the path it actually wrote; refuse anything outside this song's own
  // directory rather than trusting a subprocess's output as a filesystem path.
  const withinSongDir = relative(takesDir, downloaded.filePath)
  if (!withinSongDir || withinSongDir.startsWith('..') || isAbsolute(withinSongDir)) {
    await rm(ids.dir, { recursive: true, force: true }).catch(() => {})
    throw createError({ statusCode: 502, statusMessage: 'The download landed somewhere unexpected.' })
  }

  const song = await createSongFromAudioFile({
    actor,
    ids,
    // A video with no usable title still deserves a song, just an obviously-renameable one.
    title: downloaded.title.trim() || `YouTube ${parsed.videoId}`,
    takePath: downloaded.filePath,
    auditAction: 'song.import-youtube',
  })

  return { id: song.id, title: song.title }
})

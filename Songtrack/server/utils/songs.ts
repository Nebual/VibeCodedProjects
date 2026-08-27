import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { count, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../database/client'
import { songs, takes } from '../database/schema'
import { slugify } from '../../shared/utils/slug'
import { ffprobe, generatePeaks, renderEditList } from './ffmpeg'
import { songDir } from './paths'
import { recordAuditIfImpersonating } from './auth'
import type { AuthedUser, RequestActor } from './auth'
import { DEFAULT_EDIT_GAIN, PENDING_SONG_LIMIT } from '#shared/types'
import type { EditList } from '#shared/types'

/** Pending accounts can try the app immediately, capped so an open box can't be abused before approval. */
export function assertCanCreateSong(user: AuthedUser) {
  if (user.status !== 'pending') return
  const row = db.select({ n: count() }).from(songs).where(eq(songs.userId, user.id)).get()
  if ((row?.n ?? 0) >= PENDING_SONG_LIMIT) {
    throw createError({
      statusCode: 403,
      statusMessage: `Awaiting admin approval — pending accounts are limited to ${PENDING_SONG_LIMIT} songs.`,
    })
  }
}

export function getOwnedSong(userId: string, songId: string) {
  const song = db.select().from(songs).where(eq(songs.id, songId)).get()
  if (!song || song.userId !== userId) {
    throw createError({ statusCode: 404, statusMessage: 'Song not found' })
  }
  return song
}

/**
 * Ids and on-disk home for a song that doesn't exist yet.
 *
 * Allocated up front because both ingest paths need to name the take file *before* any
 * audio exists: the upload endpoint streams the request body straight to it, and the
 * YouTube import hands the path to yt-dlp as an output template.
 */
export interface NewSongIds {
  songId: string
  takeId: string
  /** `data/audio/<userId>/<songId>`, created eagerly. */
  dir: string
}

export function allocateSong(userId: string): NewSongIds {
  const songId = nanoid()
  return { songId, takeId: nanoid(), dir: songDir(userId, songId) }
}

export interface CreateSongFromFileOptions {
  actor: RequestActor
  ids: NewSongIds
  title: string
  /** An audio file already fully written to disk, inside `ids.dir`. */
  takePath: string
  /** Audit action recorded when an admin is impersonating, e.g. `song.upload`. */
  auditAction: string
}

/**
 * Turn an audio file already on disk into a complete, immediately-playable song.
 *
 * Shared by `POST /api/songs/upload` and `POST /api/songs/import-youtube` — everything from
 * "there are bytes on disk" onward is identical between them, and the rendering happens
 * inline (rather than as a background job) so the returned id is playable the moment the
 * client navigates to it.
 *
 * On unreadable audio the whole song directory is removed again: nothing has been written to
 * the database at that point, so leaving the bytes behind would be an orphan no UI can reach.
 */
export async function createSongFromAudioFile(
  { actor, ids, title, takePath, auditAction }: CreateSongFromFileOptions,
): Promise<{ id: string, title: string, durationS: number }> {
  const { songId, takeId, dir } = ids

  const probe = await ffprobe(takePath).catch(() => null)
  if (!probe || !probe.durationS) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
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
    gain: DEFAULT_EDIT_GAIN,
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

  recordAuditIfImpersonating(actor, auditAction, songId)

  return { id: songId, title, durationS: masterProbe.durationS }
}

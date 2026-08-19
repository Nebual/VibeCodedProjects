import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../../database/client'
import { takes } from '../../../database/schema'
import type { EditList } from '#shared/types'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

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
  const previewId = nanoid()
  const outPath = join(rendersDir(), `preview-${songId}-${previewId}.ogg`)
  await renderEditList(sources, editList, outPath, 'ogg')

  return { url: `/api/songs/${songId}/preview/${previewId}` }
})

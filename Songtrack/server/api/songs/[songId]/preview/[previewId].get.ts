import { existsSync } from 'node:fs'
import { join } from 'node:path'

const SAFE_ID = /^[A-Za-z0-9_-]+$/

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

  const previewId = getRouterParam(event, 'previewId')!
  if (!SAFE_ID.test(previewId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid preview id' })
  }

  const path = join(rendersDir(), `preview-${songId}-${previewId}.ogg`)
  if (!existsSync(path)) {
    throw createError({ statusCode: 404, statusMessage: 'Preview not found or expired' })
  }
  return streamRangeableFile(event, path, 'audio/ogg')
})

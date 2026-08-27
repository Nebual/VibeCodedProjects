import { existsSync } from 'node:fs'
import type { TranscriptionSummary } from '../../../../../shared/types'

/** Whether this song already has a transcription, so the page can skip straight to the results. */
export default defineEventHandler(async (event): Promise<TranscriptionSummary | null> => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  let row
  try {
    row = loadTranscription(song.id)
  }
  catch {
    return null
  }

  return {
    id: row.id,
    specHash: row.specHash,
    model: row.model,
    instruments: row.instruments,
    beatGrid: row.beatGrid,
    hasPreview: !!row.previewPath && existsSync(row.previewPath),
    createdAt: row.createdAt.getTime(),
  }
})

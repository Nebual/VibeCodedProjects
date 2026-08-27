/**
 * The transcribed notes plus the detected grid.
 *
 * The page drives its finished piano roll and its live onset-error readout from this rather than
 * decoding MIDI in the browser: the events are already on disk, already de-lagged, and identical
 * on a fresh run and a cache hit — so there is one code path instead of two, and no client-side
 * MIDI parser to get wrong. Playback still takes the raw MIDI bytes, which is what the synth wants.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  const song = getOwnedSong(actor.user.id, songId)

  const row = loadTranscription(song.id, getQuery(event).spec as string | undefined)
  return {
    specHash: row.specHash,
    beatGrid: row.beatGrid,
    notes: await loadNotes(row),
  }
})

/**
 * The sidecar's MT3 instrument taxonomy, behind auth. Cached in module scope inside
 * `getInstruments()` — it is static for the life of the container.
 */
export default defineEventHandler(async (event) => {
  await requireActor(event)
  return { instruments: await getInstruments() }
})

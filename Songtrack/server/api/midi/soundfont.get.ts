/**
 * The 38 MB SoundFont the in-browser synth plays through, proxied from the sidecar rather than
 * pulled from a CDN — consistent with the rest of the app, and the sidecar isn't publicly
 * reachable anyway. Immutable for the life of an image tag, so it caches hard.
 */
export default defineEventHandler(async (event) => {
  await requireActor(event)

  const etag = `"sf3-${midiWorkerModel()}-v1"`
  setHeader(event, 'Cache-Control', 'private, max-age=31536000, immutable')
  setHeader(event, 'ETag', etag)
  if (getHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return null
  }

  const upstream = await getSoundfont()
  setHeader(event, 'Content-Type', 'application/octet-stream')
  const length = upstream.headers.get('content-length')
  if (length) setHeader(event, 'Content-Length', length)
  return upstream.body
})

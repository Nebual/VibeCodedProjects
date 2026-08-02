import type { H3Event } from 'h3'

/**
 * Forward a request to the FastAPI backend, verbatim and streaming.
 *
 * Shared by the catch-all proxy and by any route that claims a specific path.
 * That second case is the reason this is a helper: registering
 * `preview.get.ts` makes Nitro match `/api/preview` exactly, so the catch-all
 * no longer sees *any* method on that path -- and POST started 404ing, taking
 * the UI's preview button with it. A path with a specific handler has to
 * re-provide the proxy for every other method it wants to keep.
 */
export async function proxyToApi(event: H3Event, path: string) {
  const { apiBase } = useRuntimeConfig()
  const query = getRequestURL(event).search

  try {
    return await proxyRequest(event, `${apiBase}/${path}${query}`)
  }
  catch (cause) {
    // A connection failure here almost always means the Python service is not
    // running, which is worth saying plainly rather than surfacing ECONNREFUSED.
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `Cannot reach the NAudioBooker API at ${apiBase}. Is it running?`,
      cause,
    })
  }
}

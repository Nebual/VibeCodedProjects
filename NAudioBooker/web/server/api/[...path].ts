/**
 * Catch-all proxy to the FastAPI backend.
 *
 * Everything under /api/** is forwarded verbatim, which keeps the browser on a
 * single origin (no CORS) and keeps the Python service off the public
 * interface. Using proxyRequest rather than $fetch matters: it streams, so SSE
 * job progress (Phase 3) and audio downloads (Phase 4) work without buffering
 * an entire book into memory.
 */
export default defineEventHandler(async (event) => {
  const { apiBase } = useRuntimeConfig()
  const path = getRouterParam(event, 'path') ?? ''
  const query = getRequestURL(event).search

  try {
    return await proxyRequest(event, `${apiBase}/${path}${query}`)
  } catch (cause) {
    // A connection failure here almost always means the Python service is not
    // running, which is worth saying plainly rather than surfacing ECONNREFUSED.
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `Cannot reach the NAudioBooker API at ${apiBase}. Is it running?`,
      cause,
    })
  }
})

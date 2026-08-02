/**
 * Catch-all proxy to the FastAPI backend.
 *
 * Everything under /api/** is forwarded verbatim, which keeps the browser on a
 * single origin (no CORS) and keeps the Python service off the public
 * interface. Using proxyRequest rather than $fetch matters: it streams, so SSE
 * job progress (Phase 3) and audio downloads (Phase 4) work without buffering
 * an entire book into memory.
 */
export default defineEventHandler(event =>
  proxyToApi(event, getRouterParam(event, 'path') ?? ''),
)

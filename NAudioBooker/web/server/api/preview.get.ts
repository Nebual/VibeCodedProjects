/**
 * GET /api/preview?text=... -- the POST endpoint, reachable from a URL.
 *
 * Exists so a preview can be pasted into an address bar, dropped into an
 * `<audio src>`, or fetched with a bare curl. The parsing lives in
 * previewFromQuery, shared with the .mp4 form.
 */
export default defineEventHandler(event =>
  // Buffered so the response carries a Content-Length; without one a browser
  // asked to display a chunked media document downloads it instead.
  relayPreview(event, previewFromQuery(event), { buffered: true }),
)

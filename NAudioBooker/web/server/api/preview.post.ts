/**
 * POST /api/preview -- the canonical form. Body straight through to the API.
 *
 * A handler rather than the catch-all proxy because `preview.get.ts` makes
 * Nitro match /api/preview as a specific route, which stops the catch-all
 * seeing any method on this path. Without this file POST returns 404 and the
 * preview button in the UI stops working.
 */
export default defineEventHandler(async event =>
  relayPreview(event, await readBody<PreviewBody>(event)),
)

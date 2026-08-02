/**
 * GET /api/preview.mp4?text=... -- the same preview, as a video.
 *
 * For embedding somewhere that will not play bare audio. Discord is the case
 * this exists for: it has no audio embed at all -- og:audio is unimplemented
 * and a direct link to an audio file gets no player -- but it will embed an
 * MP4 pointed at by og:video. The /preview page advertises this URL that way.
 *
 * The .mp4 extension is part of the path on purpose: crawlers and players are
 * markedly happier with a URL that looks like the file it returns.
 */
export default defineEventHandler(event =>
  relayPreview(event, { ...previewFromQuery(event), format: 'mp4' }, { buffered: true }),
)

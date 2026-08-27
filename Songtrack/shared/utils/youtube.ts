/**
 * YouTube link parsing, shared by the upload modal and the import endpoint.
 *
 * It lives in `shared/` because both sides need exactly the same rules: the modal so a bad
 * paste is rejected before twenty requests go out, and the server because client-side
 * validation is a convenience, never a guarantee.
 */

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
])

/** YouTube ids are exactly 11 chars from this alphabet; anything else isn't one. */
const VIDEO_ID_RE = /^[\w-]{11}$/

/** Path-based video urls: /shorts/ID, /embed/ID, /live/ID, /v/ID. */
const PATH_PREFIXES = ['shorts', 'embed', 'live', 'v', 'e']

export type NormalizedUrl =
  | { ok: true, videoId: string }
  | { ok: false, reason: string }

/**
 * Validate one pasted URL and reduce it to a bare video id.
 *
 * The host allowlist matters beyond tidiness: yt-dlp supports thousands of sites, so an
 * endpoint that forwarded arbitrary URLs would be an open "download anything to my server"
 * proxy. Reducing to an id also means the string eventually handed to yt-dlp is one we
 * rebuilt ourselves, never raw user text.
 */
export function normalizeYoutubeUrl(raw: string): NormalizedUrl {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'Enter a YouTube link.' }

  let url: URL
  try {
    // A pasted link often lacks its scheme ("youtu.be/…"); assume https rather than reject.
    url = new URL(/^[a-z][\w+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return { ok: false, reason: `Not a valid link: ${trimmed}` }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only https YouTube links are supported.' }
  }
  // Set membership, not endsWith — "youtube.com.evil.test" must not match.
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: `Only YouTube links are supported — got ${url.hostname}` }
  }

  const segments = url.pathname.split('/').filter(Boolean)
  const host = url.hostname.toLowerCase()

  // A watch url may also carry &list=…; the ?v= id wins and --no-playlist keeps it to one video.
  const vParam = url.searchParams.get('v')
  const candidate = vParam
    ?? (host.endsWith('youtu.be') ? segments[0] : undefined)
    ?? (segments.length >= 2 && PATH_PREFIXES.includes(segments[0]!.toLowerCase()) ? segments[1] : undefined)

  if (!candidate) {
    if (url.searchParams.has('list') || segments[0]?.toLowerCase() === 'playlist') {
      return { ok: false, reason: 'That is a playlist link — paste the links to individual videos instead.' }
    }
    return { ok: false, reason: `That YouTube link doesn't point at a video: ${trimmed}` }
  }
  if (!VIDEO_ID_RE.test(candidate)) {
    return { ok: false, reason: `That doesn't look like a YouTube video link: ${trimmed}` }
  }
  return { ok: true, videoId: candidate }
}

/** The canonical URL handed to yt-dlp, rebuilt from the id rather than echoed from input. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

/**
 * Split a pasted blob into candidate URLs.
 *
 * Splits on any whitespace (not just newlines) so a space-separated paste works too, and
 * dedupes by video id where the line parses — the same video pasted as youtu.be and as a
 * watch url shouldn't import twice. Lines that don't parse are kept verbatim so the caller
 * can report them one by one instead of silently dropping them.
 */
export function parseYoutubeUrls(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split(/\s+/)) {
    const candidate = line.trim()
    if (!candidate) continue
    const parsed = normalizeYoutubeUrl(candidate)
    const key = parsed.ok ? parsed.videoId : candidate
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

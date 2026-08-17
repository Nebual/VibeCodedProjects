import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Fetching a web page the user asked for, safely.
 *
 * The recipe importer takes a URL and fetches it *from the server*, which means
 * the request comes from inside the household's network. That is a confused
 * deputy waiting to happen: a link that looks like a recipe and actually points
 * at `http://192.168.1.1/admin/reset` would be fetched with whatever access the
 * app's host has. So the destination is checked before anything is opened, and
 * again after every redirect.
 *
 * The other three limits — time, size and redirect count — are about a server
 * that never comes back rather than about malice.
 */

/** Long enough for a slow food blog, short enough that nobody stares at it. */
const TIMEOUT_MS = 10000

/** A recipe page is well under this. Love and Lemons ships about 570 KB. */
const MAX_BYTES = 4 * 1024 * 1024

const MAX_REDIRECTS = 3

export class PageFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PageFetchError'
  }
}

/**
 * Is this address one we refuse to reach?
 *
 * Ranges are compared numerically, not by prefix string: `172.66.41.15` is a
 * perfectly public Cloudflare address and `172.16.0.0/12` stops at
 * `172.31.255.255`, so "starts with 172." would block the internet.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)

  if (version === 4) {
    const parts = address.split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true
    }
    const [a, b] = parts as [number, number, number, number]
    if (a === 0) return true // this network
    if (a === 10) return true // private
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
    if (a === 192 && b === 0) return true // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
    if (a >= 224) return true // multicast and reserved
    return false
  }

  if (version === 6) {
    const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
    if (lower === '::1' || lower === '::') return true
    // An IPv4-mapped address is an IPv4 address wearing a hat.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1]!)
    if (/^f[cd]/.test(lower)) return true // unique local
    if (/^fe[89ab]/.test(lower)) return true // link-local
    return false
  }

  // Not an IP literal at all — the caller resolves the hostname separately.
  return false
}

/**
 * Reject a URL we should not fetch.
 *
 * Two layers. The literal checks always run. The DNS check runs when
 * resolution is available and is skipped when it isn't — behind an egress proxy
 * the app may have no resolver of its own, and failing every import there would
 * trade a real feature for a guard that the proxy is already enforcing.
 */
export async function assertFetchableUrl(input: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new PageFetchError('That doesn’t look like a web address')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PageFetchError('Only http and https addresses can be imported')
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')

  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new PageFetchError('That address is on a private network')
    }
    return url
  }

  // A hostname can point anywhere, including at 127.0.0.1.
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new PageFetchError('That address is on a private network')
  }

  try {
    const addresses = await lookup(host, { all: true })
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new PageFetchError('That address is on a private network')
    }
  } catch (err) {
    if (err instanceof PageFetchError) throw err
    // No resolver. Documented above; carry on.
  }

  return url
}

/**
 * Fetch a page as text, following redirects by hand so each hop is checked.
 *
 * `redirect: 'manual'` is the point of this function: letting fetch follow them
 * means the first URL is validated and the one actually retrieved is not, which
 * is the standard way an SSRF guard gets walked around.
 */
export async function fetchPageHtml(input: string): Promise<{ html: string; url: string }> {
  let url = await assertFetchableUrl(input)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Honest rather than a spoofed browser string. A site that blocks
          // this is entitled to, and the user can paste the text instead.
          'User-Agent': 'Fittown recipe importer (personal nutrition tracker)',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
        },
      })
    } catch (err) {
      clearTimeout(timer)
      const aborted = err instanceof Error && err.name === 'AbortError'
      throw new PageFetchError(
        aborted ? 'That page took too long to answer' : 'Couldn’t reach that page',
      )
    }
    clearTimeout(timer)

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new PageFetchError('That page redirected to nowhere')
      if (hop === MAX_REDIRECTS) throw new PageFetchError('That page redirected too many times')
      // Re-validated, every hop.
      url = await assertFetchableUrl(new URL(location, url).toString())
      continue
    }

    if (!response.ok) {
      throw new PageFetchError(`That page returned ${response.status}`)
    }

    const type = response.headers.get('content-type') ?? ''
    if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
      throw new PageFetchError('That address isn’t a web page')
    }

    return { html: await readCapped(response), url: url.toString() }
  }

  throw new PageFetchError('That page redirected too many times')
}

/**
 * Read a response body, stopping at the cap.
 *
 * `response.text()` would buffer whatever arrives, so a hostile or broken
 * server could hand back gigabytes. Content-Length is checked first because
 * it's free, and the stream is capped anyway because it can lie.
 */
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new PageFetchError('That page is too large to import')
  }

  const reader = response.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder('utf-8')
  let total = 0
  let text = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw new PageFetchError('That page is too large to import')
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()

  return text
}

import type { H3Event } from 'h3'

/**
 * The one place a preview request reaches the Python API.
 *
 * Both /api/preview handlers end here: POST passes its JSON body through, GET
 * assembles the same body out of query parameters. Everything after that --
 * how the upstream is called, which response headers matter, what a
 * connection failure should say -- is written once, so the two forms cannot
 * drift into answering differently.
 */
export interface PreviewBody {
  /** "mp4" wraps the audio in a video, for embeds that will not play audio. */
  format?: 'wav' | 'mp4'
  text?: string | null
  voice?: string
  model?: string
  speed?: number
  options?: Record<string, number>
}

export interface RelayOptions {
  /**
   * Read the whole response before sending it, so it carries a Content-Length.
   *
   * Streaming is the better default and is what POST uses: a preview can be
   * twenty minutes of audio. But a streamed response is chunked and therefore
   * has no length, and a browser asked to *display* a media document with no
   * Content-Length downloads it rather than playing it. The GET form caps text
   * at a kilobyte, so buffering it is cheap and makes the URL work when pasted
   * into an address bar.
   */
  buffered?: boolean
}

/**
 * Text limit for the GET form.
 *
 * The POST endpoint accepts 20,000 characters, but that cannot survive a URL:
 * browsers start truncating around 2,000 and many proxies reject a request
 * line over 8 KB. Capping well below that turns a silently mangled preview
 * into a clear error naming the form that has no such limit.
 */
const MAX_TEXT = 1000

/** Knobs a caller can set per request. Unknown ones are ignored by the model. */
const TUNING_KNOBS = ['exaggeration', 'cfg_weight'] as const

function one(value: unknown): string | undefined {
  // A repeated parameter arrives as an array; take the last, which is what
  // someone appending to a URL almost certainly meant.
  const raw = Array.isArray(value) ? value.at(-1) : value
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function num(value: unknown, name: string): number | undefined {
  const raw = one(value)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: `${name} must be a number, got ${JSON.stringify(raw)}`,
    })
  }
  return parsed
}

/**
 * Build a preview request out of a query string.
 *
 * Shared by /api/preview and /api/preview.mp4, which differ only in what they
 * ask the API to encode -- the parameters, the limits and the error messages
 * are identical and should stay that way.
 */
export function previewFromQuery(event: H3Event): PreviewBody {
  const query = getQuery(event)

  const text = one(query.text)?.trim()
  if (!text) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Pass the words to speak as ?text=... (or POST to /api/preview).',
    })
  }
  if (text.length > MAX_TEXT) {
    throw createError({
      statusCode: 413,
      statusMessage: 'Payload Too Large',
      message:
        `That is ${text.length} characters; the GET form is capped at ${MAX_TEXT} `
        + 'because longer will not survive a URL. POST to /api/preview instead, '
        + 'which accepts 20,000.',
    })
  }

  const options: Record<string, number> = {}
  for (const knob of TUNING_KNOBS) {
    const value = num(query[knob], knob)
    if (value !== undefined) options[knob] = value
  }

  return {
    text,
    voice: one(query.voice) ?? '',
    model: one(query.model),
    speed: num(query.speed, 'speed') ?? 1.0,
    options,
  }
}

export async function relayPreview(
  event: H3Event,
  body: PreviewBody,
  options: RelayOptions = {},
) {
  const { apiBase } = useRuntimeConfig()

  if (options.buffered) return bufferedPreview(event, apiBase, body)

  try {
    // sendProxy rather than a buffered $fetch: it streams the audio straight
    // through, and it relays the upstream status and headers as they are. That
    // second part is what keeps the two forms honest -- X-Cache, the suggested
    // filename and any error body arrive identically whichever one was called.
    return await sendProxy(event, `${apiBase}/preview`, {
      fetchOptions: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    })
  }
  catch (cause) {
    // No HTTP status at all means the connection failed, which almost always
    // means the Python service is not running. Worth saying plainly rather
    // than surfacing ECONNREFUSED.
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `Cannot reach the NAudioBooker API at ${apiBase}. Is it running?`,
      cause,
    })
  }
}

/** Fetch the audio in full, then send it with an accurate Content-Length. */
async function bufferedPreview(event: H3Event, apiBase: string, body: PreviewBody) {
  let response
  try {
    response = await $fetch.raw<ArrayBuffer>(`${apiBase}/preview`, {
      method: 'POST',
      body,
      responseType: 'arrayBuffer',
    })
  }
  catch (cause) {
    throw previewError(cause, apiBase)
  }

  const audio = new Uint8Array(response._data as ArrayBuffer)
  // Carried over verbatim where the upstream set them, so the two forms stay
  // indistinguishable apart from the length.
  setResponseHeaders(event, {
    'Content-Type': response.headers.get('content-type') ?? 'audio/wav',
    'Content-Length': String(audio.byteLength),
    'Content-Disposition':
      response.headers.get('content-disposition') ?? 'inline; filename="preview.wav"',
    'Cache-Control': 'no-store',
    'X-Audio-Duration': response.headers.get('x-audio-duration') ?? '',
    'X-Cache': response.headers.get('x-cache') ?? '',
  })
  return audio
}

/**
 * Turn a failed upstream call into an H3 error.
 *
 * Asking for a binary response means the error body is binary too, so the
 * `{detail: ...}` the fetch layer would normally parse arrives as an
 * ArrayBuffer. readApiDetail knows the shapes FastAPI uses; this only decodes.
 */
function previewError(cause: unknown, apiBase: string) {
  const status = (cause as { status?: number }).status
  const data = (cause as { data?: unknown }).data

  let detail: string | undefined
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer)
    detail = readApiDetailFromText(new TextDecoder().decode(bytes))
  }
  else if (data && typeof data === 'object') {
    detail = readApiDetail(data)
  }

  if (typeof status !== 'number' || status < 400) {
    return createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `Cannot reach the NAudioBooker API at ${apiBase}. Is it running?`,
      cause,
    })
  }
  return createError({
    statusCode: status,
    statusMessage: 'Preview failed',
    // Never the raw FetchError message: it embeds the internal API URL.
    message: detail ?? 'Preview failed.',
  })
}

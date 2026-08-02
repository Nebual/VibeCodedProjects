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

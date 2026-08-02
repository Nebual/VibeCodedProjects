/**
 * GET /api/preview?text=... -- the POST endpoint, reachable from a URL.
 *
 * Exists so a preview can be pasted into an address bar, dropped into an
 * `<audio src>`, or fetched with a bare curl. This file is only the
 * translation from query string to request body; relayPreview does the rest,
 * so the two forms cannot answer differently.
 */

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

export default defineEventHandler(async (event) => {
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

  // Buffered, unlike POST. The GET form is capped at a kilobyte of text, so
  // the audio is small enough to hold -- and holding it is what lets the
  // response carry a Content-Length, without which a browser asked to display
  // a chunked media document downloads it instead of playing it.
  return relayPreview(event, {
    text,
    voice: one(query.voice) ?? '',
    model: one(query.model),
    speed: num(query.speed, 'speed') ?? 1.0,
    options,
  }, { buffered: true })
})

/**
 * Reading an error out of a FastAPI response.
 *
 * Shared between the browser and the Nitro server because both call the same
 * Python API and both hit the same two problems.
 *
 * First, FastAPI reports failures in two shapes. A handler that raises
 * HTTPException gives `detail` as a string. A request that fails schema
 * validation gives a 422 whose `detail` is a list of `{loc, msg}` objects.
 * Handling only the string leaves the second as an unexplained failure --
 * which is what an out-of-range speed used to be, on both sides.
 *
 * Second, both callers ask for a binary response, because a preview is audio.
 * That means the *error* body arrives binary too, so the parsed `{detail}` the
 * fetch layer would normally hand over is a Blob or an ArrayBuffer instead.
 * Each side decodes its own flavour of that and passes the result here.
 */
export function readApiDetail(body: unknown): string | undefined {
  const detail = (body as { detail?: unknown })?.detail

  if (typeof detail === 'string') return detail.trim() || undefined

  if (Array.isArray(detail)) {
    // Validation errors: name the offending field, since "input should be
    // less than or equal to 2" alone does not say what was wrong.
    const parts = detail
      .map((item) => {
        const msg = typeof item?.msg === 'string' ? item.msg : undefined
        if (!msg) return undefined
        const field = Array.isArray(item?.loc) ? item.loc.at(-1) : undefined
        return typeof field === 'string' ? `${field}: ${msg}` : msg
      })
      .filter((part): part is string => Boolean(part))
    if (parts.length) return parts.join('; ')
  }

  return undefined
}

/** Parse a JSON error body that arrived as bytes, and pull the detail out. */
export function readApiDetailFromText(text: string): string | undefined {
  try {
    return readApiDetail(JSON.parse(text))
  }
  catch {
    // Not JSON -- an upstream crash page, or an empty body.
    return undefined
  }
}

import type { EssentiaReport, TargetMap } from '../utils/essentiaStore'

/**
 * The sample payloads this dashboard is fed use trailing commas, which strict
 * JSON.parse rejects, so fall back to a lenient pass before giving up.
 */
function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1'))
  }
}

function readCount(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `${field} must be a non-negative integer`,
    })
  }
  return parsed
}

/** Optional positive integer; absent means "leave the stored limit alone". */
function readLimit(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  return readCount(value, field)
}

/**
 * Optional { "Ignis": 400 } map — the shape of every field in a report. Absent
 * means the caller is reporting something else, so the stored copy stands.
 */
function readAmountMap(value: unknown, field: string): TargetMap | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: `${field} must be an object of { "AspectName": number }`,
    })
  }

  const map: TargetMap = {}
  for (const [name, amount] of Object.entries(value as Record<string, unknown>)) {
    const key = name.trim()
    if (key) {
      map[key] = readCount(amount, `${field}.${name}`)
    }
  }
  return map
}

export default defineEventHandler(async (event) => {
  const raw = await readRawBody(event, 'utf8')
  if (!raw) {
    throw createError({ statusCode: 400, statusMessage: 'Empty body' })
  }

  let body: unknown
  try {
    body = parseBody(raw)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Body is not valid JSON' })
  }

  const payload = (body ?? {}) as Record<string, unknown>

  const report: EssentiaReport = {
    essentia: readAmountMap(payload.essentia, 'essentia'),
    items: readAmountMap(payload.items, 'items'),
    maxEssentiaTypes: readLimit(payload.maxEssentiaTypes, 'maxEssentiaTypes'),
    maxEssentiaAmount: readLimit(payload.maxEssentiaAmount, 'maxEssentiaAmount'),
    minimums: readAmountMap(payload.minimums, 'minimums'),
    maximums: readAmountMap(payload.maximums, 'maximums'),
  }

  const next = applyReport(report)

  // The caller only needs the targets back — they may have been edited from the
  // dashboard since the last report, and this server is the source of truth.
  return { minimums: next.minimums, maximums: next.maximums }
})

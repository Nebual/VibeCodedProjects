import type { TargetKind } from '../../utils/essentiaStore'

const KINDS: TargetKind[] = ['minimums', 'maximums']

/**
 * Dashboard-side edit of a single aspect's target. `value: null` clears it.
 * Broadcasts like any other change, so every open dashboard follows along.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: unknown, kind?: unknown, value?: unknown }>(event)

  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'name is required' })
  }

  const kind = body?.kind as TargetKind
  if (!KINDS.includes(kind)) {
    throw createError({
      statusCode: 400,
      statusMessage: `kind must be one of ${KINDS.join(', ')}`,
    })
  }

  let value: number | null = null
  if (body?.value !== null && body?.value !== undefined) {
    const parsed = Number(body.value)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw createError({
        statusCode: 400,
        statusMessage: 'value must be a non-negative integer, or null to clear',
      })
    }
    value = parsed
  }

  return setTarget(name, kind, value)
})

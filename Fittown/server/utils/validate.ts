/** Small hand-rolled validators — enough for this app, no extra dependency. */

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const
export type Meal = (typeof MEALS)[number]

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

/** Assert a 'YYYY-MM-DD' calendar date that actually exists. */
export function assertDate(value: unknown, field = 'date'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    bad(`${field} must be formatted YYYY-MM-DD`)
  }
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d!))
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m! - 1 ||
    dt.getUTCDate() !== d
  ) {
    bad(`${field} is not a real calendar date`)
  }
  return value
}

export function assertMeal(value: unknown): Meal {
  if (typeof value !== 'string' || !MEALS.includes(value as Meal)) {
    bad(`meal must be one of: ${MEALS.join(', ')}`)
  }
  return value as Meal
}

/** Assert a finite number within range. */
export function assertNumber(
  value: unknown,
  field: string,
  { min = -Infinity, max = Infinity }: { min?: number; max?: number } = {},
): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) bad(`${field} must be a number`)
  if (n < min || n > max) bad(`${field} must be between ${min} and ${max}`)
  return n
}

export function assertId(value: unknown, field = 'id'): number {
  return assertNumber(value, field, { min: 1, max: Number.MAX_SAFE_INTEGER })
}

/** Optional number: undefined/null/'' pass through as null. */
export function optionalNumber(
  value: unknown,
  field: string,
  range?: { min?: number; max?: number },
): number | null {
  if (value === undefined || value === null || value === '') return null
  return assertNumber(value, field, range)
}

export function optionalText(value: unknown, maxLength = 200): string | null {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  if (s === '') return null
  return s.slice(0, maxLength)
}

/** Assert a boolean, accepting real booleans only — no truthy strings. */
export function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') bad(`${field} must be a boolean`)
  return value
}

export function assertText(value: unknown, field: string, maxLength = 200): string {
  const s = optionalText(value, maxLength)
  if (!s) bad(`${field} is required`)
  return s
}

import { beforeAll, describe, expect, it } from 'vitest'
import type {
  assertDate as AssertDate,
  assertId as AssertId,
  assertMeal as AssertMeal,
  assertNumber as AssertNumber,
  assertText as AssertText,
  optionalNumber as OptionalNumber,
  optionalText as OptionalText,
} from '../server/utils/validate'

/**
 * The validators every API route runs its body through.
 *
 * `createError` is a Nitro auto-import, so it doesn't exist outside the Nuxt
 * build. Stubbing it with something that throws matches the real behaviour
 * closely enough to assert on: h3 turns a thrown error into the 400 response.
 */
let assertDate: typeof AssertDate
let assertMeal: typeof AssertMeal
let assertNumber: typeof AssertNumber
let assertId: typeof AssertId
let assertText: typeof AssertText
let optionalNumber: typeof OptionalNumber
let optionalText: typeof OptionalText

beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).createError = (options: {
    statusCode: number
    statusMessage: string
  }) => Object.assign(new Error(options.statusMessage), options)

  const mod = await import('../server/utils/validate')
  ;({
    assertDate, assertMeal, assertNumber, assertId, assertText,
    optionalNumber, optionalText,
  } = mod)
})

describe('assertDate', () => {
  it('accepts a real calendar day', () => {
    expect(assertDate('2026-08-16')).toBe('2026-08-16')
    expect(assertDate('2024-02-29')).toBe('2024-02-29')
  })

  it('rejects dates that do not exist', () => {
    // A plain regex would let all of these through, and they'd become diary
    // days you could never navigate back to.
    expect(() => assertDate('2026-02-30')).toThrow(/not a real calendar date/)
    expect(() => assertDate('2025-02-29')).toThrow(/not a real calendar date/)
    expect(() => assertDate('2026-13-01')).toThrow()
    expect(() => assertDate('2026-00-10')).toThrow()
  })

  it('rejects anything not formatted YYYY-MM-DD', () => {
    for (const bad of ['16/08/2026', '2026-8-16', 'today', '', null, undefined, 20260816]) {
      expect(() => assertDate(bad)).toThrow(/formatted YYYY-MM-DD/)
    }
  })

  it('names the field it was checking', () => {
    expect(() => assertDate('nope', 'from')).toThrow(/^from/)
  })
})

describe('assertNumber', () => {
  it('accepts numbers and numeric strings', () => {
    expect(assertNumber(42, 'x')).toBe(42)
    expect(assertNumber('42.5', 'x')).toBe(42.5)
  })

  it('rejects values that are not finite numbers', () => {
    for (const bad of ['abc', null, undefined, {}, Number.NaN, Infinity]) {
      expect(() => assertNumber(bad, 'x')).toThrow(/must be a number/)
    }
  })

  it('enforces the range, inclusively', () => {
    expect(assertNumber(10, 'x', { min: 10, max: 20 })).toBe(10)
    expect(assertNumber(20, 'x', { min: 10, max: 20 })).toBe(20)
    expect(() => assertNumber(9, 'x', { min: 10, max: 20 })).toThrow(/between 10 and 20/)
    expect(() => assertNumber(21, 'x', { min: 10, max: 20 })).toThrow(/between 10 and 20/)
  })
})

describe('assertId', () => {
  it('accepts a positive row id', () => {
    expect(assertId(1)).toBe(1)
    expect(assertId('123')).toBe(123)
  })

  it('rejects zero and negatives', () => {
    expect(() => assertId(0)).toThrow()
    expect(() => assertId(-5)).toThrow()
  })
})

describe('optionalNumber', () => {
  it('passes absent values through as null', () => {
    // Distinguishing "not sent" from zero is what lets a PATCH clear a field.
    expect(optionalNumber(undefined, 'x')).toBeNull()
    expect(optionalNumber(null, 'x')).toBeNull()
    expect(optionalNumber('', 'x')).toBeNull()
  })

  it('keeps a real zero', () => {
    expect(optionalNumber(0, 'x')).toBe(0)
  })

  it('still validates anything actually supplied', () => {
    expect(() => optionalNumber('abc', 'x')).toThrow(/must be a number/)
    expect(() => optionalNumber(500, 'x', { min: 0, max: 100 })).toThrow(/between/)
  })
})

describe('text validators', () => {
  it('trims and length-caps optional text', () => {
    expect(optionalText('  hello  ')).toBe('hello')
    expect(optionalText('x'.repeat(300), 200)).toHaveLength(200)
  })

  it('treats blank text as absent', () => {
    expect(optionalText('   ')).toBeNull()
    expect(optionalText(null)).toBeNull()
    expect(optionalText(undefined)).toBeNull()
  })

  it('requires non-blank text where a value is mandatory', () => {
    expect(assertText(' Bicep ', 'name')).toBe('Bicep')
    expect(() => assertText('   ', 'name')).toThrow(/name is required/)
    expect(() => assertText(null, 'name')).toThrow(/name is required/)
  })
})

describe('assertMeal', () => {
  it('accepts the four meals', () => {
    for (const meal of ['breakfast', 'lunch', 'dinner', 'snack']) {
      expect(assertMeal(meal)).toBe(meal)
    }
  })

  it('rejects anything else', () => {
    expect(() => assertMeal('brunch')).toThrow(/meal must be one of/)
    expect(() => assertMeal(undefined)).toThrow()
  })
})

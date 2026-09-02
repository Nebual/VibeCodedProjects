import { describe, expect, it } from 'vitest'
import { evaluateMath, fieldText } from '../shared/mathExpr'

/**
 * The amount field's arithmetic. Pure by construction — no `eval`, no DOM —
 * so every rule the user can hit is pinned here rather than in a component.
 */

/** The number a valid expression comes to, or the kind when it isn't one. */
const val = (text: string, min?: number) => {
  const r = evaluateMath(text, { min })
  return r.kind === 'value' || r.kind === 'plain' ? r.value : r.kind
}

describe('evaluateMath — arithmetic', () => {
  it('adds, subtracts, multiplies and divides', () => {
    expect(val('100+40')).toBe(140)
    expect(val('140-40')).toBe(100)
    expect(val('50*3')).toBe(150)
    expect(val('100/4')).toBe(25)
  })

  it('gives * and / precedence over + and -', () => {
    expect(val('2+3*4')).toBe(14)
    expect(val('10-6/2')).toBe(7)
  })

  it('honours parentheses', () => {
    expect(val('(100+50)*3')).toBe(450)
    expect(val('((2+3))*2')).toBe(10)
  })

  it('is left-associative', () => {
    expect(val('100/2/5')).toBe(10)
    expect(val('10-3-2')).toBe(5)
  })

  it('accepts a leading unary minus inside an expression', () => {
    expect(val('10*-2', undefined)).toBe(-20)
  })
})

describe('evaluateMath — the ways people actually type it', () => {
  it('accepts x, X and × as multiply', () => {
    expect(val('50x4')).toBe(200)
    expect(val('50X4')).toBe(200)
    expect(val('50×4')).toBe(200)
  })

  it('accepts ÷ as divide', () => {
    expect(val('100÷4')).toBe(25)
  })

  it('ignores a leading = the way a spreadsheet does', () => {
    expect(val('=50*3')).toBe(150)
    expect(val('= 50 * 3')).toBe(150)
  })

  it('ignores whitespace around operators', () => {
    expect(val('100 + 40')).toBe(140)
  })

  it('takes a comma as a decimal point, like a pasted recipe line', () => {
    expect(val('1,5*2')).toBe(3)
  })

  it('reads vulgar fractions and mixed numbers', () => {
    expect(val('½')).toBe(0.5)
    expect(val('1½*2')).toBe(3)
    expect(val('1 1/2')).toBe(1.5)
    expect(val('1 1/2 * 2')).toBe(3)
  })

  it('still reads a bare fraction as division', () => {
    expect(val('1/2')).toBe(0.5)
  })
})

describe('evaluateMath — result kinds', () => {
  it('calls an empty field empty', () => {
    expect(evaluateMath('')).toEqual({ kind: 'empty' })
    expect(evaluateMath('   ')).toEqual({ kind: 'empty' })
  })

  it('calls a bare number plain, so no formula gets stored for it', () => {
    expect(evaluateMath('140')).toEqual({ kind: 'plain', value: 140 })
    expect(evaluateMath('1.5')).toEqual({ kind: 'plain', value: 1.5 })
    expect(evaluateMath(' 140 ')).toEqual({ kind: 'plain', value: 140 })
  })

  it('calls anything else a value, formula and all', () => {
    expect(evaluateMath('100+40')).toEqual({ kind: 'value', value: 140 })
    // Typed as a mixed number, so the text is worth keeping even though it
    // comes to a single figure.
    expect(evaluateMath('1 1/2')).toEqual({ kind: 'value', value: 1.5 })
  })

  it('calls a half-typed expression incomplete, not an error', () => {
    expect(evaluateMath('100+').kind).toBe('incomplete')
    expect(evaluateMath('2*').kind).toBe('incomplete')
    expect(evaluateMath('(100+50').kind).toBe('incomplete')
    expect(evaluateMath('(').kind).toBe('incomplete')
    expect(evaluateMath('=').kind).toBe('incomplete')
  })

  it('calls input that cannot become valid an error', () => {
    expect(evaluateMath('100++4').kind).toBe('error')
    expect(evaluateMath('100)').kind).toBe('error')
    expect(evaluateMath('abc').kind).toBe('error')
    expect(evaluateMath('100 40').kind).toBe('error')
  })

  it('refuses to divide by zero rather than reporting Infinity', () => {
    const r = evaluateMath('5/0')
    expect(r.kind).toBe('error')
    expect(r.kind === 'error' && r.message).toMatch(/divide by zero/i)
  })
})

describe('evaluateMath — range and rounding', () => {
  it('rejects a negative result where the field cannot go below zero', () => {
    expect(evaluateMath('100-140', { min: 0 }).kind).toBe('error')
  })

  it('allows a negative result where no minimum is set', () => {
    expect(val('100-140')).toBe(-40)
  })

  it('rounds to four decimals, so the preview is exactly what gets stored', () => {
    expect(val('100/3')).toBe(33.3333)
  })

  it('rounds float noise away', () => {
    expect(val('0.1+0.2')).toBe(0.3)
  })
})

describe('fieldText — a formula is shown only when it still holds', () => {
  it('shows the formula when it evaluates to the stored amount', () => {
    expect(fieldText(200, '50x4')).toBe('50x4')
  })

  it('falls back to the number when the amount has since moved', () => {
    expect(fieldText(180, '50x4')).toBe('180')
  })

  it('shows the number when there is no formula', () => {
    expect(fieldText(140, null)).toBe('140')
  })

  it('shows nothing for no value at all', () => {
    expect(fieldText(null, null)).toBe('')
    expect(fieldText(null, '50x4')).toBe('')
  })

  it('tolerates the parser rounding, within 1e-4', () => {
    expect(fieldText(33.3333, '100/3')).toBe('100/3')
  })
})

import { describe, expect, it } from 'vitest'
import { useMathInput } from '../app/composables/useMathInput'

/**
 * The rules a numeric field follows between keystrokes. Kept out of the
 * component because Vitest runs with `environment: 'node'` — there is no DOM to
 * mount into, and these rules are the part that must not drift.
 */

describe('useMathInput — what reaches the parent', () => {
  it('reports a plain number with no formula', () => {
    const field = useMathInput({ min: 0 })
    field.text.value = '140'
    expect(field.emission()).toEqual({ value: 140, formula: null })
  })

  it('reports an expression with the text that produced it', () => {
    const field = useMathInput({ min: 0 })
    field.text.value = '100+40'
    expect(field.emission()).toEqual({ value: 140, formula: '100+40' })
  })

  it('trims the stored formula', () => {
    const field = useMathInput({ min: 0 })
    field.text.value = '  50x4  '
    expect(field.emission()).toEqual({ value: 200, formula: '50x4' })
  })

  it('clears both when the field is emptied', () => {
    const field = useMathInput({ min: 0 })
    field.text.value = ''
    expect(field.emission()).toEqual({ value: null, formula: null })
  })

  it('says nothing while an expression is half-typed', () => {
    const field = useMathInput({ min: 0 })
    field.text.value = '100+'
    expect(field.emission()).toBeNull()
  })

  it('says nothing when the text is invalid, so the last good value stands', () => {
    const field = useMathInput({ min: 0 })
    field.text.value = '100-140'
    expect(field.emission()).toBeNull()
  })
})

describe('useMathInput — preview and error state', () => {
  it('previews only a real expression, never a bare number', () => {
    const field = useMathInput({ min: 0 })
    field.text.value = '100+40'
    expect(field.previewValue.value).toBe(140)
    field.text.value = '140'
    expect(field.previewValue.value).toBeNull()
  })

  it('shows no preview mid-typing', () => {
    const field = useMathInput({ min: 0 })
    field.text.value = '100+'
    expect(field.previewValue.value).toBeNull()
  })

  it('flags invalid text, but not half-typed text', () => {
    const field = useMathInput({ min: 0 })
    field.text.value = '100+'
    expect(field.invalid.value).toBe(false)
    field.text.value = '100++4'
    expect(field.invalid.value).toBe(true)
  })
})

describe('useMathInput — adopting a value from the parent', () => {
  it('shows a stored formula that still holds', () => {
    const field = useMathInput({ min: 0 })
    field.adopt(200, '50x4')
    expect(field.text.value).toBe('50x4')
  })

  it('shows the number when the stored formula no longer holds', () => {
    const field = useMathInput({ min: 0 })
    field.adopt(180, '50x4')
    expect(field.text.value).toBe('180')
  })

  it('refuses to overwrite what the user is currently typing', () => {
    const field = useMathInput({ min: 0 })
    field.focused.value = true
    field.text.value = '100+'
    field.adopt(140, null)
    expect(field.text.value).toBe('100+')
  })

  it('adopts again once focus has left, settling a half-typed field', () => {
    const field = useMathInput({ min: 0 })
    field.focused.value = true
    field.text.value = '100+'
    field.focused.value = false
    field.adopt(100, null)
    expect(field.text.value).toBe('100')
  })
})

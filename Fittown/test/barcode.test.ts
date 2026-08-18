import { describe, expect, it } from 'vitest'
import { barcodeCandidates } from '../server/utils/barcode'

/**
 * A scan came back "0067000003196" for a can whose barcode is stored in Open
 * Food Facts as the compressed UPC-E "06731906" — the report that prompted
 * this file. Neither form is a zero-padding variant of the other, so only a
 * real UPC-E <-> UPC-A/EAN-13 conversion can bridge them.
 */
describe('barcodeCandidates', () => {
  it('bridges a UPC-E stored barcode from its scanned EAN-13 expansion', () => {
    expect(barcodeCandidates('0067000003196')).toContain('06731906')
  })

  it('bridges the same pair the other way, from the compressed scan', () => {
    const candidates = barcodeCandidates('06731906')
    expect(candidates).toContain('067000003196')
    expect(candidates).toContain('0067000003196')
  })

  it('still finds the ordinary zero-padding variants', () => {
    expect(barcodeCandidates('0012345678905')).toContain('12345678905')
    expect(barcodeCandidates('12345678905')).toContain('0012345678905')
  })

  it('does not invent a UPC-E candidate for a code that has none', () => {
    // A UPC-A whose trailing digits don't fit any UPC-E compression pattern.
    const candidates = barcodeCandidates('012345678905')
    expect(candidates.some((c) => c.length === 8)).toBe(false)
  })
})

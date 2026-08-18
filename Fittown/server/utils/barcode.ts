/**
 * UPC-E <-> UPC-A conversion.
 *
 * A scanner's Barcode Detection API expands a UPC-E symbol (the compressed
 * 8-digit code printed on small packaging) to its full UPC-A/EAN-13 form in
 * `rawValue` — that's the API's own contract, not something this app
 * controls. But a barcode crowd-sourced into Open Food Facts is stored
 * exactly as whoever submitted it typed it, which for a lot of small-format
 * products is still the compressed 8-digit form. Matching a scan against the
 * database means being able to go either way between the two.
 */

/** Expands an 8-digit UPC-E (number system + 6 digits + check) to a 12-digit UPC-A. */
function expandUpcE(upcE: string): string | null {
  if (!/^\d{8}$/.test(upcE)) return null
  const ns = upcE[0]!
  if (ns !== '0' && ns !== '1') return null
  const [d1, d2, d3, d4, d5, d6] = upcE.slice(1, 7).split('')
  const check = upcE[7]!

  let body: string
  if (d6 === '0' || d6 === '1' || d6 === '2') body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`
  else if (d6 === '3') body = `${d1}${d2}${d3}00000${d4}${d5}`
  else if (d6 === '4') body = `${d1}${d2}${d3}${d4}00000${d5}`
  else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`

  return `${ns}${body}${check}`
}

/** Compresses a 12-digit UPC-A back to UPC-E, when its trailing zeros allow it. */
function compressToUpcE(upcA: string): string | null {
  if (!/^\d{12}$/.test(upcA)) return null
  const ns = upcA[0]!
  if (ns !== '0' && ns !== '1') return null
  const body = upcA.slice(1, 11)
  const check = upcA[11]!

  if (body.slice(3, 7) === '0000' && ['0', '1', '2'].includes(body[2]!)) {
    return `${ns}${body[0]}${body[1]}${body[7]}${body[8]}${body[9]}${body[2]}${check}`
  }
  if (body.slice(3, 8) === '00000') {
    return `${ns}${body[0]}${body[1]}${body[2]}${body[8]}${body[9]}3${check}`
  }
  if (body.slice(4, 9) === '00000') {
    return `${ns}${body[0]}${body[1]}${body[2]}${body[3]}${body[9]}4${check}`
  }
  if (body.slice(5, 9) === '0000' && /[5-9]/.test(body[9]!)) {
    return `${ns}${body[0]}${body[1]}${body[2]}${body[3]}${body[4]}${body[9]}${check}`
  }
  return null
}

/**
 * Every form a scanned code might be stored under: the digits as scanned, the
 * usual EAN-13/UPC-A zero-padding variants, and — the case a zero-padding
 * check alone can't bridge — its UPC-E compressed or expanded equivalent.
 */
export function barcodeCandidates(rawCode: string): string[] {
  const code = rawCode.replace(/\D/g, '')
  const candidates = new Set<string>([code, code.padStart(13, '0'), code.replace(/^0+/, '')])

  const upcA = code.length === 13 && code.startsWith('0') ? code.slice(1)
    : code.length === 12 ? code
    : null
  const upcE = upcA ? compressToUpcE(upcA) : code.length === 8 ? code : null
  const expanded = upcE ? expandUpcE(upcE) : null

  if (upcE) candidates.add(upcE)
  if (expanded) {
    candidates.add(expanded)
    candidates.add(`0${expanded}`)
    candidates.add(expanded.replace(/^0+/, ''))
  }

  return [...candidates]
}

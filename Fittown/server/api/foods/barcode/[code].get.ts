import { barcodeCandidates } from '../../../utils/barcode'
import { foodCols } from '../../../utils/foods'

/**
 * Look up a scanned barcode locally.
 *
 * The whole point of importing OFF is that this never leaves the machine, so
 * there's no network fallback: a miss is a miss, and the UI offers to create a
 * custom food instead.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const raw = getRouterParam(event, 'code') ?? ''
  const code = raw.replace(/\D/g, '')

  if (code.length < 6 || code.length > 14) {
    throw createError({ statusCode: 400, statusMessage: 'Not a valid barcode' })
  }

  const db = useDb()

  // Barcodes are stored as written in OFF, which zero-pads to varying widths
  // (EAN-13 vs UPC-A for the same product) and sometimes keeps small-package
  // barcodes in their compressed UPC-E form rather than the UPC-A/EAN-13 a
  // scanner's Barcode Detection API expands them to. Try every equivalent form.
  for (const candidate of barcodeCandidates(code)) {
    const food = db
      .prepare(
        `SELECT ${foodCols()} FROM foods f
         WHERE barcode = ? AND (owner_user_id IS NULL OR owner_user_id = ?)
         ORDER BY popularity DESC LIMIT 1`,
      )
      .get(candidate, user.id)
    if (food) return { food }
  }

  throw createError({ statusCode: 404, statusMessage: 'No food with that barcode' })
})

import { generateToken, hashToken } from '../../utils/deviceAuth'

/**
 * Exchange an outstanding pairing code for a device token.
 *
 * No session required — the whole point is pairing a phone that isn't signed
 * in yet. The code was minted by a signed-in browser at
 * POST /api/devices/pair-code and is single-use (claiming clears pair_code)
 * and short-lived (pair_expires).
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event)
  const code = assertText(body.code, 'code', 16).toUpperCase()
  const name = optionalText(body.name, 100) ?? 'Unnamed device'

  const db = useDb()
  const pending = db
    .prepare(
      `SELECT id FROM device_tokens
       WHERE pair_code = ? AND token_hash IS NULL AND pair_expires > datetime('now')`,
    )
    .get(code) as { id: number } | undefined

  if (!pending) {
    throw createError({ statusCode: 404, statusMessage: 'Pairing code expired or not found' })
  }

  const token = generateToken()

  db.prepare(
    `UPDATE device_tokens
     SET token_hash = ?, name = ?, pair_code = NULL, pair_expires = NULL
     WHERE id = ?`,
  ).run(hashToken(token), name, pending.id)

  // Shown once — the server keeps only the hash from here on.
  return { token, device_id: pending.id }
})

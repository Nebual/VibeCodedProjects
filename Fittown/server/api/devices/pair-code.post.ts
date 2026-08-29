import { generatePairCode, pairCodeExpiresAt } from '../../utils/deviceAuth'

/**
 * Start pairing a phone. Called from a signed-in browser (Settings ->
 * Connect a phone); returns a short code the phone app exchanges for a
 * device token at POST /api/devices/claim.
 *
 * The phone itself isn't signed in yet — that's the point of device pairing
 * (docs/samsung-health-sync.md §3) — so the code, not a session, is what it
 * carries between the two requests.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()

  const code = generatePairCode()
  const expires = pairCodeExpiresAt()

  // token_hash stays NULL until claimed — see the column comment in
  // server/db/schema.ts. This row is the "pairing outstanding" state.
  const info = db
    .prepare(
      `INSERT INTO device_tokens (user_id, name, pair_code, pair_expires)
       VALUES (?, 'Unnamed device', ?, ?)`,
    )
    .run(user.id, code, expires)

  return { id: Number(info.lastInsertRowid), code, expires_at: expires }
})

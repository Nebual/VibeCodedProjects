import { createPairCode } from '../../utils/deviceAuth'

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
  const { code, expiresAt } = createPairCode(useDb(), user.id)
  return { code, expires_at: expiresAt }
})

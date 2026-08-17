import { inviteExpiryClause, newToken } from '../../../utils/friends'

/** Two or three outstanding links is a family; fifty is a leak. */
const MAX_LIVE_INVITES = 10

/**
 * Mint an invite link.
 *
 * Returns the token only — the page builds the URL from its own origin, which
 * is right by construction. Deriving it server-side means guessing the public
 * hostname and scheme from request headers, and behind a TLS-terminating proxy
 * that guess is wrong unless X-Forwarded-Proto is set (see AGENTS.md §6).
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}))
  const note = optionalText(body?.note, 60)

  const db = useDb()

  const { live } = db
    .prepare(
      `SELECT COUNT(*) AS live FROM friend_invites
       WHERE inviter_id = ? AND revoked_at IS NULL AND accepted_at IS NULL
         AND expires_at > datetime('now')`,
    )
    .get(user.id) as { live: number }

  if (live >= MAX_LIVE_INVITES) {
    throw createError({
      statusCode: 400,
      statusMessage: `You already have ${MAX_LIVE_INVITES} unused invite links. Cancel one first.`,
    })
  }

  const token = newToken()
  db.prepare(
    `INSERT INTO friend_invites (token, inviter_id, note, expires_at)
     VALUES (?, ?, ?, ${inviteExpiryClause()})`,
  ).run(token, user.id, note)

  const invite = db
    .prepare(
      `SELECT token, note, created_at, expires_at, accepted_at, revoked_at
       FROM friend_invites WHERE token = ?`,
    )
    .get(token)

  setResponseStatus(event, 201)
  return { invite }
})

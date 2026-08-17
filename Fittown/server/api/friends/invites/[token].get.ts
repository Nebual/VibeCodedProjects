import { friendDisplayName, inviteProblem, isShareToken } from '#shared/friends'

/**
 * What an invite link says before you accept it.
 *
 * Readable without signing in, because the visitor may not have an account
 * yet: the page has to be able to say "Alice invited you" *before* sending
 * them through Google, or they're asked to log into a site they've been given
 * no reason to trust.
 *
 * It reveals the inviter's display name and nothing else — no email, no id, and
 * nothing about their diary. Whoever holds the link was handed it by that
 * person on purpose.
 */
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (!isShareToken(token)) {
    throw createError({ statusCode: 404, statusMessage: 'No such invite' })
  }

  const invite = useDb()
    .prepare(
      `SELECT i.token, i.expires_at, i.accepted_at, i.revoked_at,
              u.id AS inviter_id, u.name AS inviter_name, u.email AS inviter_email
       FROM friend_invites i
       JOIN users u ON u.id = i.inviter_id
       WHERE i.token = ?`,
    )
    .get(token) as
    | {
        expires_at: string
        accepted_at: string | null
        revoked_at: string | null
        inviter_id: number
        inviter_name: string
        inviter_email: string
      }
    | undefined

  if (!invite) throw createError({ statusCode: 404, statusMessage: 'No such invite' })

  const problem = inviteProblem(invite, new Date().toISOString())

  return {
    // The name is all the visitor needs, and all they're entitled to.
    inviter: { id: invite.inviter_id, name: friendDisplayName({
      name: invite.inviter_name,
      email: invite.inviter_email,
    }) },
    usable: problem === null,
    problem,
    expires_at: invite.expires_at,
  }
})

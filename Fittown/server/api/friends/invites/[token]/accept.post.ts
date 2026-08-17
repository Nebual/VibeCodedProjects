import { friendDisplayName, inviteProblem, isShareToken } from '#shared/friends'
import { establishFriendship, findUserById } from '../../../../utils/friends'

/**
 * Take up an invite link.
 *
 * Both consents are already in: the inviter minted the link, and whoever is
 * signed in here pressed Accept. So this creates an *accepted* friendship
 * rather than another pending request for the inviter to answer.
 *
 * The link is single-use, and the claim is the same UPDATE that checks it is
 * still usable — two people opening the same link at once can't both get in,
 * because only one of them changes a row.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const token = getRouterParam(event, 'token')
  if (!isShareToken(token)) {
    throw createError({ statusCode: 404, statusMessage: 'No such invite' })
  }

  return transact((db) => {
    const invite = db
      .prepare('SELECT * FROM friend_invites WHERE token = ?')
      .get(token) as
      | {
          inviter_id: number
          expires_at: string
          accepted_at: string | null
          accepted_by: number | null
          revoked_at: string | null
        }
      | undefined

    if (!invite) throw createError({ statusCode: 404, statusMessage: 'No such invite' })

    if (invite.inviter_id === user.id) {
      throw createError({ statusCode: 400, statusMessage: 'That’s your own invite link' })
    }

    const problem = inviteProblem(invite, new Date().toISOString())
    if (problem) throw createError({ statusCode: 410, statusMessage: problem })

    const claimed = db
      .prepare(
        `UPDATE friend_invites
         SET accepted_by = ?, accepted_at = datetime('now')
         WHERE token = ? AND accepted_at IS NULL AND revoked_at IS NULL
           AND expires_at > datetime('now')`,
      )
      .run(user.id, token)

    if (claimed.changes === 0) {
      throw createError({ statusCode: 410, statusMessage: 'This invite link has already been used.' })
    }

    establishFriendship(db, invite.inviter_id, user.id)

    const inviter = findUserById(db, invite.inviter_id)
    return {
      ok: true,
      friend: inviter,
      name: inviter ? friendDisplayName(inviter) : 'your friend',
    }
  })
})

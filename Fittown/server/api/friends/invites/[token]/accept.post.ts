import { friendDisplayName, inviteProblem, isShareToken } from '#shared/friends'
import { establishFriendship, findUserById } from '../../../../utils/friends'

/**
 * Take up an invite link.
 *
 * Both consents are already in: the inviter minted the link, and whoever is
 * signed in here pressed Accept. So this creates an *accepted* friendship
 * rather than another pending request for the inviter to answer.
 *
 * The link is multi-use — it keeps working, for anyone, until the inviter
 * cancels it or it expires — so there is nothing to claim here. Accepting it
 * twice, whether that's the same person double-clicking or a second friend
 * using the same link, is harmless: `establishFriendship()` only ever moves a
 * pair to accepted, it never errors or duplicates.
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
          revoked_at: string | null
        }
      | undefined

    if (!invite) throw createError({ statusCode: 404, statusMessage: 'No such invite' })

    if (invite.inviter_id === user.id) {
      throw createError({ statusCode: 400, statusMessage: 'That’s your own invite link' })
    }

    const problem = inviteProblem(invite, new Date().toISOString())
    if (problem) throw createError({ statusCode: 410, statusMessage: problem })

    establishFriendship(db, invite.inviter_id, user.id)

    const inviter = findUserById(db, invite.inviter_id)
    return {
      ok: true,
      friend: inviter,
      name: inviter ? friendDisplayName(inviter) : 'your friend',
    }
  })
})

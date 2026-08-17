import { listFriends, listIncoming, listOutgoing } from '../../utils/friends'

/**
 * Everything the Friends tab draws: who you share with, who is waiting on you,
 * who you're waiting on, and any invite links still outstanding.
 *
 * One request rather than four — the page shows all of it at once, and the
 * lists are a handful of rows each.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()

  const invites = db
    .prepare(
      `SELECT token, note, created_at, expires_at, accepted_at, revoked_at
       FROM friend_invites
       WHERE inviter_id = ? AND revoked_at IS NULL AND accepted_at IS NULL
         AND expires_at > datetime('now')
       ORDER BY created_at DESC`,
    )
    .all(user.id)

  return {
    friends: listFriends(db, user.id),
    incoming: listIncoming(db, user.id),
    outgoing: listOutgoing(db, user.id),
    invites,
  }
})

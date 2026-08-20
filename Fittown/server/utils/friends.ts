import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import {
  FRIEND_ACCEPTED,
  FRIEND_PENDING,
  INVITE_TTL_DAYS,
  friendDisplayName,
} from '#shared/friends'
import type { FriendUser } from '#shared/friends'
import { sharePermissions } from '#shared/sharing'
import type { ShareKey, SharePermissions } from '#shared/sharing'

/**
 * Friendship storage and — more importantly — the one place that decides
 * whether user A may read user B's rows.
 *
 * Everywhere else in this app the rule is "scope by `user_id`" (see AGENTS.md).
 * Friends are the single exception, so they get a single gate:
 * `requireFriendship()`. Every route that reads someone else's data calls it
 * first and nothing else opens that door. If you add a friend-scoped endpoint,
 * call it there too rather than writing your own join — a missed check here
 * leaks a health diary, not a preference.
 */

export interface FriendshipRow {
  id: number
  requester_id: number
  addressee_id: number
  status: string
  created_at: string
  responded_at: string | null
}

/** Columns of `users` that may be shown to another person. Never `google_sub`. */
const USER_FIELDS = 'id, name, email, avatar_url'

/**
 * A bearer token for an invite or a share link.
 *
 * 16 random bytes — the same order of entropy as a session id. base64url so it
 * survives being pasted into a chat window, an email client that underlines
 * URLs, and a QR code.
 */
export function newToken(): string {
  return randomBytes(16).toString('base64url')
}

/** `datetime('now', '+30 days')` as a value, so the TTL lives in shared code. */
export function inviteExpiryClause(): string {
  return `datetime('now', '+${INVITE_TTL_DAYS} days')`
}

export function findUserByEmail(db: DatabaseSync, email: string): FriendUser | undefined {
  return db
    .prepare(`SELECT ${USER_FIELDS} FROM users WHERE LOWER(email) = LOWER(?)`)
    .get(email) as FriendUser | undefined
}

export function findUserById(db: DatabaseSync, id: number): FriendUser | undefined {
  return db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(id) as
    | FriendUser
    | undefined
}

/** The relationship between two people, in whichever direction it was created. */
export function friendshipBetween(
  db: DatabaseSync,
  a: number,
  b: number,
): FriendshipRow | undefined {
  return db
    .prepare(
      `SELECT * FROM friendships
       WHERE (requester_id = ? AND addressee_id = ?)
          OR (requester_id = ? AND addressee_id = ?)`,
    )
    .get(a, b, b, a) as FriendshipRow | undefined
}

/** Are these two accepted friends? The predicate behind every shared read. */
export function areFriends(db: DatabaseSync, a: number, b: number): boolean {
  return friendshipBetween(db, a, b)?.status === FRIEND_ACCEPTED
}

/**
 * The gate. Returns the friend's public row, or throws.
 *
 * 404 rather than 403 for a stranger: whether a given user id exists is not
 * something an outsider should be able to probe, and "not found" is also the
 * honest answer from the viewer's point of view — they have no such friend.
 */
export function requireFriendship(
  db: DatabaseSync,
  viewerId: number,
  otherId: number,
): FriendUser {
  if (viewerId === otherId) {
    throw createError({ statusCode: 400, statusMessage: 'That is you' })
  }
  if (!areFriends(db, viewerId, otherId)) {
    throw createError({ statusCode: 404, statusMessage: 'Not one of your friends' })
  }
  const user = findUserById(db, otherId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not one of your friends' })
  return user
}

/**
 * What this person has agreed to share, from their settings row.
 *
 * Absent row or absent columns read as "everything", matching the column
 * defaults — see `sharePermissions()`.
 */
export function friendPermissions(db: DatabaseSync, ownerId: number): SharePermissions {
  const goals = db.prepare('SELECT * FROM user_goals WHERE user_id = ?').get(ownerId) as
    | Record<string, unknown>
    | undefined
  return sharePermissions(goals)
}

/**
 * The gate, plus the one switch that governs this particular screen.
 *
 * Two separate refusals, deliberately worded differently: a stranger gets
 * "not one of your friends" (404), while a friend who has turned a section off
 * gets a 403 that says so — otherwise the page looks broken and they ask the
 * wrong person why.
 */
export function requireSharedSection(
  db: DatabaseSync,
  viewerId: number,
  ownerId: number,
  key: ShareKey,
): { friend: FriendUser; permissions: SharePermissions } {
  const friend = requireFriendship(db, viewerId, ownerId)
  const permissions = friendPermissions(db, ownerId)
  if (!permissions[key]) {
    throw createError({
      statusCode: 403,
      statusMessage: `${friendDisplayName(friend)} isn’t sharing that`,
    })
  }
  return { friend, permissions }
}

/** Ids of everyone this user has an accepted friendship with. */
export function friendIds(db: DatabaseSync, userId: number): number[] {
  return (
    db
      .prepare(
        `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id
         FROM friendships
         WHERE status = ? AND (requester_id = ? OR addressee_id = ?)`,
      )
      .all(userId, FRIEND_ACCEPTED, userId, userId) as { id: number }[]
  ).map((row) => Number(row.id))
}

/**
 * May `viewer` read one of `owner`'s own (custom) foods?
 *
 * The one predicate behind "friends can see each other's custom foods", used by
 * search (to include them), the food detail page (to draw one) and the diary
 * (to log one). Friendship plus the `share_custom_foods` toggle — the same
 * shape as every other friend-scoped read. Callers still check
 * `source = 'custom'` and `owner != viewer` themselves; this only answers the
 * friendship+consent half of the question.
 */
export function friendSharesCustomFoods(
  db: DatabaseSync,
  viewerId: number,
  ownerId: number,
): boolean {
  if (viewerId === ownerId) return true
  if (!areFriends(db, viewerId, ownerId)) return false
  return friendPermissions(db, ownerId)['share_custom_foods']
}

export interface FriendListEntry extends FriendUser {
  /** Row id of the friendship, so the UI can act on it without re-deriving. */
  friendship_id: number
  since: string | null
}

export interface PendingEntry extends FriendUser {
  friendship_id: number
  created_at: string
}

/** Accepted friends, alphabetically — the Friends tab reads top to bottom. */
export function listFriends(db: DatabaseSync, userId: number): FriendListEntry[] {
  return db
    .prepare(
      `SELECT u.id, u.name, u.email, u.avatar_url,
              f.id AS friendship_id, f.responded_at AS since
       FROM friendships f
       JOIN users u
         ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       WHERE f.status = ? AND (f.requester_id = ? OR f.addressee_id = ?)
       ORDER BY COALESCE(NULLIF(u.name, ''), u.email) COLLATE NOCASE`,
    )
    .all(userId, FRIEND_ACCEPTED, userId, userId) as FriendListEntry[]
}

/** Requests waiting on *this* user to answer. What the accept prompt shows. */
export function listIncoming(db: DatabaseSync, userId: number): PendingEntry[] {
  return db
    .prepare(
      `SELECT u.id, u.name, u.email, u.avatar_url, f.id AS friendship_id, f.created_at
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = ? AND f.status = ?
       ORDER BY f.created_at`,
    )
    .all(userId, FRIEND_PENDING) as PendingEntry[]
}

/** Requests this user has sent and nobody has answered yet. */
export function listOutgoing(db: DatabaseSync, userId: number): PendingEntry[] {
  return db
    .prepare(
      `SELECT u.id, u.name, u.email, u.avatar_url, f.id AS friendship_id, f.created_at
       FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       WHERE f.requester_id = ? AND f.status = ?
       ORDER BY f.created_at`,
    )
    .all(userId, FRIEND_PENDING) as PendingEntry[]
}

/**
 * Create a friendship, or accept the one already coming the other way.
 *
 * Two people inviting each other at the same moment is the case worth getting
 * right: the unordered unique index means the second insert fails, and the
 * kind answer is to treat "I asked you while you were asking me" as mutual
 * consent rather than as an error the user has to make sense of.
 *
 * Returns what happened so the caller can word the response.
 */
export function requestFriendship(
  db: DatabaseSync,
  requesterId: number,
  addresseeId: number,
): { status: 'pending' | 'accepted' | 'already_friends' } {
  const existing = friendshipBetween(db, requesterId, addresseeId)

  if (existing) {
    if (existing.status === FRIEND_ACCEPTED) return { status: 'already_friends' }

    // They asked us first — answering by asking back is a yes.
    if (existing.addressee_id === requesterId) {
      acceptFriendship(db, existing.id, requesterId)
      return { status: 'accepted' }
    }
    // We already asked them. Not an error; the request is simply still out.
    return { status: 'pending' }
  }

  db.prepare(
    'INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, ?)',
  ).run(requesterId, addresseeId, FRIEND_PENDING)

  return { status: 'pending' }
}

/**
 * Make two people friends outright, whatever state they were in.
 *
 * For invite links only. Both consents are already in hand — one person minted
 * the link, the other opened it and pressed Accept — so there is nothing left
 * to be pending about, and leaving it pending would strand the pair waiting on
 * an approval neither of them can see.
 */
export function establishFriendship(db: DatabaseSync, aId: number, bId: number): void {
  const existing = friendshipBetween(db, aId, bId)

  if (!existing) {
    db.prepare(
      `INSERT INTO friendships (requester_id, addressee_id, status, responded_at)
       VALUES (?, ?, ?, datetime('now'))`,
    ).run(aId, bId, FRIEND_ACCEPTED)
    return
  }

  if (existing.status === FRIEND_ACCEPTED) return

  db.prepare(
    `UPDATE friendships SET status = ?, responded_at = datetime('now') WHERE id = ?`,
  ).run(FRIEND_ACCEPTED, existing.id)
}

/**
 * Accept a pending request addressed to `userId`.
 *
 * Scoped by addressee so a guessed friendship id is a no-op — the same rule the
 * rest of the app's updates follow.
 */
export function acceptFriendship(db: DatabaseSync, friendshipId: number, userId: number): boolean {
  const info = db
    .prepare(
      `UPDATE friendships
       SET status = ?, responded_at = datetime('now')
       WHERE id = ? AND addressee_id = ? AND status = ?`,
    )
    .run(FRIEND_ACCEPTED, friendshipId, userId, FRIEND_PENDING)
  return info.changes > 0
}

/**
 * Decline, cancel or unfriend — all the same row, deleted.
 *
 * Either party may remove it in any state: declining an unwanted request and
 * ending a friendship are the same wish, and keeping a tombstone would only
 * stop the two of them starting over.
 */
export function removeFriendship(db: DatabaseSync, friendshipId: number, userId: number): boolean {
  const info = db
    .prepare(
      'DELETE FROM friendships WHERE id = ? AND (requester_id = ? OR addressee_id = ?)',
    )
    .run(friendshipId, userId, userId)
  return info.changes > 0
}

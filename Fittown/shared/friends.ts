/**
 * Friendship and sharing rules, shared by the server and the UI.
 *
 * Pure, like everything else in `shared/`: the same helpers decide whether an
 * invite is still usable on the server (before it grants access) and in the
 * browser (before it offers an Accept button), so the two can't disagree about
 * what a link is worth.
 *
 * The relative `./` imports elsewhere in this folder carry explicit extensions
 * so plain `node` can load them; nothing here imports anything, so it doesn't
 * arise.
 */

/** A request that has been sent but not answered. */
export const FRIEND_PENDING = 'pending'
/** Both people can see each other's trends and recipes. */
export const FRIEND_ACCEPTED = 'accepted'

export type FriendStatus = typeof FRIEND_PENDING | typeof FRIEND_ACCEPTED

/**
 * How long an unused invite link stays valid.
 *
 * A link is a bearer token — whoever holds it becomes a friend and can read a
 * health diary — so it expires even though nobody is likely to attack a family
 * app. Thirty days is long enough to survive "I'll do it at the weekend".
 */
export const INVITE_TTL_DAYS = 30

/** Shape the API returns for another person. Never includes anything private. */
export interface FriendUser {
  id: number
  name: string
  email: string
  avatar_url: string | null
}

/**
 * What to call someone.
 *
 * Google gives us a name for nearly everyone, but a seeded or dev account can
 * have an empty one, and "" renders as a blank row that looks broken. The email
 * local part is a better fallback than "Unknown".
 */
export function friendDisplayName(user: {
  name?: string | null
  email?: string | null
}): string {
  const name = (user.name ?? '').trim()
  if (name) return name
  const email = (user.email ?? '').trim()
  if (email) return email.split('@')[0] || email
  return 'Someone'
}

/** First letter, for the avatar circle when there's no picture. */
export function friendInitial(user: { name?: string | null; email?: string | null }): string {
  return friendDisplayName(user).charAt(0).toUpperCase()
}

/**
 * Normalise a timestamp for comparison.
 *
 * SQLite writes `datetime('now')` as `YYYY-MM-DD HH:MM:SS` in UTC, while
 * JavaScript hands out `YYYY-MM-DDTHH:MM:SS.sssZ`. Both sort correctly as
 * strings *within* their own format and incorrectly against each other, which
 * is exactly the sort of bug that only shows up on the day a link expires.
 */
export function comparableTime(value: string): string {
  return value.replace('T', ' ').replace('Z', '').slice(0, 19)
}

export interface InviteState {
  expires_at: string
  accepted_at?: string | null
  revoked_at?: string | null
}

/** Can this invite still be accepted? */
export function isInviteUsable(invite: InviteState, now: string): boolean {
  if (invite.accepted_at) return false
  if (invite.revoked_at) return false
  return comparableTime(invite.expires_at) > comparableTime(now)
}

/** Why an invite can't be used, in words a visitor can act on. */
export function inviteProblem(invite: InviteState, now: string): string | null {
  if (invite.revoked_at) return 'This invite link was cancelled.'
  if (invite.accepted_at) return 'This invite link has already been used.'
  if (!isInviteUsable(invite, now)) return 'This invite link has expired.'
  return null
}

/**
 * A name for a copied recipe that doesn't collide with one you already have.
 *
 * Copying a friend's "Chili" when you have your own would otherwise leave two
 * identically named rows in the list, in search and in the portion picker, with
 * nothing to tell them apart. The first copy keeps the plain name if it's free.
 */
export function uniqueCopyName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()))
  const trimmed = base.trim().slice(0, 180) || 'Recipe'

  if (!used.has(trimmed.toLowerCase())) return trimmed

  for (let n = 2; n < 100; n++) {
    const candidate = n === 2 ? `${trimmed} (copy)` : `${trimmed} (copy ${n - 1})`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  // Ninety-nine copies of one recipe is not a case worth designing for, but
  // returning something colliding is worse than an ugly name.
  return `${trimmed} (copy ${Date.now()})`
}

/** Where an invite link points. */
export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/invite/${token}`
}

/** Where a shared-recipe link points. Short, because people paste these. */
export function sharedRecipeUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/r/${token}`
}

/**
 * Is this a plausible share token?
 *
 * Tokens are base64url of 16 random bytes. Checking the shape before hitting
 * the database turns a mistyped URL into a 404 instead of a query.
 */
export function isShareToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value)
}

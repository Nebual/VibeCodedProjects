import type { H3Event } from 'h3'
import { useDb } from './db'

export interface DbUser {
  id: number
  google_sub: string | null
  email: string
  name: string
  avatar_url: string | null
}

/**
 * Find or create the local user row for a Google identity.
 *
 * Matching is by `sub` (Google's immutable subject id) first, falling back to
 * email so that an account whose address changed, or one seeded before first
 * login, links up rather than duplicating.
 */
export function upsertGoogleUser(profile: {
  sub: string
  email: string
  name?: string
  picture?: string
}): DbUser {
  const db = useDb()

  const bySub = db
    .prepare('SELECT * FROM users WHERE google_sub = ?')
    .get(profile.sub) as DbUser | undefined

  if (bySub) {
    db.prepare(
      'UPDATE users SET email = ?, name = ?, avatar_url = ? WHERE id = ?',
    ).run(profile.email, profile.name ?? bySub.name, profile.picture ?? null, bySub.id)
    return { ...bySub, email: profile.email, name: profile.name ?? bySub.name }
  }

  const byEmail = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(profile.email) as DbUser | undefined

  if (byEmail) {
    db.prepare(
      'UPDATE users SET google_sub = ?, name = ?, avatar_url = ? WHERE id = ?',
    ).run(profile.sub, profile.name ?? byEmail.name, profile.picture ?? null, byEmail.id)
    return { ...byEmail, google_sub: profile.sub }
  }

  const info = db
    .prepare(
      'INSERT INTO users (google_sub, email, name, avatar_url) VALUES (?, ?, ?, ?)',
    )
    .run(profile.sub, profile.email, profile.name ?? '', profile.picture ?? null)

  const id = Number(info.lastInsertRowid)
  ensureGoals(id)
  return {
    id,
    google_sub: profile.sub,
    email: profile.email,
    name: profile.name ?? '',
    avatar_url: profile.picture ?? null,
  }
}

/** Every user needs a goals row; create it lazily with schema defaults. */
export function ensureGoals(userId: number) {
  useDb()
    .prepare('INSERT OR IGNORE INTO user_goals (user_id) VALUES (?)')
    .run(userId)
}

/**
 * Resolve the signed-in user for an API request, or throw 401.
 *
 * The session cookie only carries the user id; everything else is read fresh
 * so that a revoked or deleted account can't keep acting on a stale cookie.
 */
export async function requireUser(event: H3Event): Promise<DbUser> {
  const session = await getUserSession(event)
  const id = (session?.user as { id?: number } | undefined)?.id

  if (!id) {
    throw createError({ statusCode: 401, statusMessage: 'Not signed in' })
  }

  const user = useDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | DbUser
    | undefined

  if (!user) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'Account no longer exists' })
  }

  ensureGoals(user.id)
  return user
}

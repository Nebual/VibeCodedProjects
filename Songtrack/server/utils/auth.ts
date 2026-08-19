import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { H3Event } from 'h3'
import { db } from '../database/client'
import { auditLog, users } from '../database/schema'
import type { UserRole, UserStatus } from '#shared/types'

export interface AuthedUser {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: UserRole
  status: UserStatus
}

export interface RequestActor {
  /** The account whose data this request should read/write. */
  user: AuthedUser
  /** The person actually signed in — differs from `user` only while impersonating. */
  realUser: AuthedUser
  isImpersonating: boolean
}

/**
 * Resolves the acting user for a request, honoring admin impersonation.
 * Every song/tag/album/render query should scope by `actor.user.id`.
 */
export async function requireActor(event: H3Event): Promise<RequestActor> {
  const session = await requireUserSession(event)
  const realUser = session.user as AuthedUser

  if (realUser.status === 'rejected') {
    throw createError({ statusCode: 403, statusMessage: 'This account has been rejected.' })
  }

  const impersonatingUserId = session.impersonatingUserId
  if (impersonatingUserId && realUser.role === 'admin') {
    const target = db.select().from(users).where(eq(users.id, impersonatingUserId)).get()
    if (target) {
      return { user: target as AuthedUser, realUser, isImpersonating: true }
    }
  }

  return { user: realUser, realUser, isImpersonating: false }
}

/** Convenience for handlers that don't care about impersonation, just identity. */
export async function requireUser(event: H3Event): Promise<AuthedUser> {
  const actor = await requireActor(event)
  return actor.user
}

export async function requireAdmin(event: H3Event): Promise<AuthedUser> {
  const session = await requireUserSession(event)
  const user = session.user as AuthedUser
  if (user.role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Admin only.' })
  }
  return user
}

/** Every mutation made while impersonating is attributed to the admin, not just the target. */
export function recordAuditIfImpersonating(actor: RequestActor, action: string, detail?: string) {
  if (!actor.isImpersonating) return
  db.insert(auditLog).values({
    id: nanoid(),
    actorUserId: actor.realUser.id,
    action,
    targetUserId: actor.user.id,
    detail: detail ?? null,
    createdAt: new Date(),
  }).run()
}

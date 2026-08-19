import { desc, inArray } from 'drizzle-orm'
import { db } from '../../database/client'
import { auditLog, users } from '../../database/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)

  const rows = db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(100).all()
  const userIds = [...new Set(rows.flatMap(r => [r.actorUserId, r.targetUserId].filter((v): v is string => !!v)))]
  const userRows = userIds.length ? db.select().from(users).where(inArray(users.id, userIds)).all() : []
  const nameById = new Map(userRows.map(u => [u.id, u.name]))

  return rows.map(r => ({
    id: r.id,
    action: r.action,
    actorName: nameById.get(r.actorUserId) ?? r.actorUserId,
    targetName: r.targetUserId ? (nameById.get(r.targetUserId) ?? r.targetUserId) : null,
    detail: r.detail,
    createdAt: r.createdAt,
  }))
})

import { count, eq } from 'drizzle-orm'
import { db } from '../../../database/client'
import { songs, users } from '../../../database/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)

  const allUsers = db.select().from(users).all()
  return allUsers.map((u) => {
    const songCount = db.select({ n: count() }).from(songs).where(eq(songs.userId, u.id)).get()?.n ?? 0
    const bytes = dirSizeBytes(userAudioDir(u.id))
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      songCount,
      bytes,
    }
  })
})

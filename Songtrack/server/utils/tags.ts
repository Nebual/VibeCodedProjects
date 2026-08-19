import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../database/client'
import { songTags, tags } from '../database/schema'

/** Upserts each tag by name for the user, bumps recency, and links it to the song. */
export function attachTagsToSong(userId: string, songId: string, tagNames: string[]) {
  const now = new Date()
  for (const raw of tagNames) {
    const name = raw.trim()
    if (!name) continue

    let tag = db.select().from(tags).where(and(eq(tags.userId, userId), eq(tags.name, name))).get()
    if (!tag) {
      tag = { id: nanoid(), userId, name, lastUsedAt: now }
      db.insert(tags).values(tag).run()
    } else {
      db.update(tags).set({ lastUsedAt: now }).where(eq(tags.id, tag.id)).run()
    }

    db.insert(songTags).values({ songId, tagId: tag.id, createdAt: now }).onConflictDoNothing().run()
  }
}

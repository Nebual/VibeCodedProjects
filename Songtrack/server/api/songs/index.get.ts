import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../database/client'
import { songs, songTags, tags } from '../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const query = getQuery(event)
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''

  let rows = db.select().from(songs).where(eq(songs.userId, actor.user.id)).orderBy(desc(songs.createdAt)).all()
  if (q) {
    rows = rows.filter(s => s.title.toLowerCase().includes(q))
  }

  const songIds = rows.map(r => r.id)
  const tagRows = songIds.length
    ? db.select({ songId: songTags.songId, name: tags.name })
        .from(songTags)
        .innerJoin(tags, eq(songTags.tagId, tags.id))
        .where(inArray(songTags.songId, songIds))
        .all()
    : []

  const tagsBySong = new Map<string, string[]>()
  for (const tr of tagRows) {
    const arr = tagsBySong.get(tr.songId) ?? []
    arr.push(tr.name)
    tagsBySong.set(tr.songId, arr)
  }

  const filterTags = typeof query.tags === 'string'
    ? query.tags.split(',').map(t => t.trim()).filter(Boolean)
    : []
  const tagMode = query.tagMode === 'or' ? 'or' : 'and'
  if (filterTags.length) {
    rows = rows.filter((s) => {
      const songTagNames = tagsBySong.get(s.id) ?? []
      return tagMode === 'and'
        ? filterTags.every(t => songTagNames.includes(t))
        : filterTags.some(t => songTagNames.includes(t))
    })
  }

  return rows.map(s => ({
    id: s.id,
    title: s.title,
    rating: s.rating,
    durationS: s.durationS,
    musicKey: s.musicKey,
    timeSignature: s.timeSignature,
    createdAt: s.createdAt,
    tags: tagsBySong.get(s.id) ?? [],
  }))
})

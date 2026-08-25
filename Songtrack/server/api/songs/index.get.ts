import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../database/client'
import { songs, songTags, takes, tags } from '../../database/schema'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const query = getQuery(event)
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
  const sort = query.sort === 'title' || query.sort === 'rating' ? query.sort : 'recent'

  let rows = db.select().from(songs).where(eq(songs.userId, actor.user.id)).orderBy(desc(songs.createdAt)).all()
  if (q) {
    rows = rows.filter(s => s.title.toLowerCase().includes(q))
  }

  const songIds = rows.map(r => r.id)
  const [tagRows, takeRows] = songIds.length
    ? [
        db.select({ songId: songTags.songId, name: tags.name })
          .from(songTags)
          .innerJoin(tags, eq(songTags.tagId, tags.id))
          .where(inArray(songTags.songId, songIds))
          .all(),
        db.select({ songId: takes.songId, createdAt: takes.createdAt })
          .from(takes)
          .where(inArray(takes.songId, songIds))
          .all(),
      ]
    : [[], []]

  const tagsBySong = new Map<string, string[]>()
  for (const tr of tagRows) {
    const arr = tagsBySong.get(tr.songId) ?? []
    arr.push(tr.name)
    tagsBySong.set(tr.songId, arr)
  }

  const lastTakeBySong = new Map<string, Date>()
  for (const tr of takeRows) {
    const existing = lastTakeBySong.get(tr.songId)
    if (!existing || tr.createdAt > existing) lastTakeBySong.set(tr.songId, tr.createdAt)
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

  const withRecordedAt = rows.map(s => ({
    id: s.id,
    title: s.title,
    rating: s.rating,
    durationS: s.durationS,
    musicKey: s.musicKey,
    timeSignature: s.timeSignature,
    createdAt: s.createdAt,
    recordedAt: lastTakeBySong.get(s.id) ?? s.createdAt,
    tags: tagsBySong.get(s.id) ?? [],
  }))

  if (sort === 'title') {
    withRecordedAt.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  } else if (sort === 'rating') {
    withRecordedAt.sort((a, b) => {
      if (a.rating === b.rating) return b.recordedAt.getTime() - a.recordedAt.getTime()
      if (a.rating === null) return 1
      if (b.rating === null) return -1
      return b.rating - a.rating
    })
  } else {
    withRecordedAt.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
  }

  return withRecordedAt
})

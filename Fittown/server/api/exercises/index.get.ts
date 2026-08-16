/** Exercise library: shared seeds plus the caller's own additions. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { q } = getQuery(event)
  const text = typeof q === 'string' ? q.trim() : ''

  const where = ['(owner_user_id IS NULL OR owner_user_id = ?)']
  const params: unknown[] = [user.id]

  if (text) {
    where.push('name LIKE ?')
    params.push(`%${text}%`)
  }

  const results = useDb()
    .prepare(
      `SELECT id, name, category, met, owner_user_id
       FROM exercises
       WHERE ${where.join(' AND ')}
       ORDER BY (owner_user_id IS NOT NULL) DESC, name
       LIMIT 100`,
    )
    .all(...params)

  return { results }
})

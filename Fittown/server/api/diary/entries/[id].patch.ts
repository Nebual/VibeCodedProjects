/** Adjust the portion or move an entry to a different meal. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'entry id')
  const body = await readBody<Record<string, unknown>>(event)

  const sets: string[] = []
  const params: unknown[] = []

  if (body.grams !== undefined) {
    sets.push('grams = ?')
    params.push(assertNumber(body.grams, 'grams', { min: 0.1, max: 20000 }))
  }
  if (body.meal !== undefined) {
    sets.push('meal = ?')
    params.push(assertMeal(body.meal))
  }
  if (body.serving_label !== undefined) {
    sets.push('serving_label = ?')
    params.push(optionalText(body.serving_label, 60))
  }
  if (body.serving_count !== undefined) {
    sets.push('serving_count = ?')
    params.push(optionalNumber(body.serving_count, 'serving_count', { min: 0.01, max: 1000 }))
  }

  if (sets.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to update' })
  }

  params.push(id, user.id)
  const info = useDb()
    .prepare(`UPDATE diary_entries SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
    .run(...params)

  if (info.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Entry not found' })
  }
  return { ok: true }
})

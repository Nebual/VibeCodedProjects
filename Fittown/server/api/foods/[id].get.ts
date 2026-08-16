import { foodCols } from '../../utils/foods'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'food id')
  const db = useDb()

  const food = db
    .prepare(
      `SELECT ${foodCols()} FROM foods f
       WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)`,
    )
    .get(id, user.id)

  if (!food) throw createError({ statusCode: 404, statusMessage: 'Food not found' })

  const servings = db
    .prepare('SELECT id, label, grams, is_default FROM food_servings WHERE food_id = ? ORDER BY grams')
    .all(id)

  return { food, servings }
})

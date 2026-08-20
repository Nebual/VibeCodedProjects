import { foodCols } from '../../utils/foods'
import { friendSharesCustomFoods } from '../../utils/friends'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'food id')
  const db = useDb()

  const food = db
    .prepare(
      `SELECT ${foodCols()} FROM foods f
       WHERE id = ?`,
    )
    .get(id) as
    | (Record<string, unknown> & {
        source: string
        owner_user_id: number | null
        reported_by: number | null
      })
    | undefined

  if (!food) throw createError({ statusCode: 404, statusMessage: 'Food not found' })

  // A food owned by someone else is only a read if that person is a friend who
  // shares their custom foods — and only a custom food, never a recipe (friend
  // recipes are read through their own route and copied before logging). Anything
  // else is indistinguishable from not existing.
  if (food.owner_user_id !== null && food.owner_user_id !== user.id) {
    const allowed =
      food.source === 'custom'
      && friendSharesCustomFoods(db, user.id, Number(food.owner_user_id))
    if (!allowed) throw createError({ statusCode: 404, statusMessage: 'Food not found' })
  }

  const servings = db
    .prepare('SELECT id, label, grams, is_default FROM food_servings WHERE food_id = ? ORDER BY grams')
    .all(id)

  return { food, servings }
})

import { requireSharedSection } from '../../utils/friends'
import { copyCustomFoodInto } from '../../utils/recipes'

/**
 * Take a copy of a friend's custom food into your own library.
 *
 * Mirrors the recipe copy route: `{ friend_id, food_id }` must belong to an
 * accepted friend who has turned on Custom foods sharing. The copy is a fresh
 * `source = 'custom'` row owned by you — `copyCustomFoodInto` is idempotent (a
 * food you already own with the same name/brand/kcal is returned instead of
 * duplicated), and it re-indexes the new row so it is immediately searchable.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const friendId = assertId(body.friend_id, 'friend_id')
  const foodId = assertId(body.food_id, 'food_id')

  return transact((db) => {
    requireSharedSection(db, user.id, friendId, 'share_custom_foods')

    // The row must be one of that friend's own custom foods — a friendship is
    // not a key to a food belonging to a stranger, or to a recipe (copies of
    // those go through the recipe copy route, which handles the deep copy).
    const owned = db
      .prepare(
        `SELECT id FROM foods
         WHERE id = ? AND owner_user_id = ? AND source = 'custom'`,
      )
      .get(foodId, friendId) as { id: number } | undefined
    if (!owned) {
      throw createError({ statusCode: 404, statusMessage: 'Food not found' })
    }

    const id = copyCustomFoodInto(db, foodId, user.id)
    const copy = db.prepare('SELECT id, name FROM foods WHERE id = ?').get(id) as {
      id: number
      name: string
    }

    setResponseStatus(event, 201)
    return copy
  })
})
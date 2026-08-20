import { requireSharedSection } from '../../../../utils/friends'
import { copyCustomFoodInto } from '../../../../utils/recipes'

/** Copy a friend's custom food into your own foods. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'friend id')
  const foodId = assertId(getRouterParam(event, 'foodId'), 'food id')

  const db = useDb()
  const { friend } = requireSharedSection(db, user.id, id, 'share_custom_foods')

  // Verify the food belongs to the friend and is a custom food
  const food = db
    .prepare('SELECT id, name, brand, owner_user_id, source FROM foods WHERE id = ?')
    .get(foodId) as { id: number; name: string; brand: string | null; owner_user_id: number | null; source: string } | undefined

  if (!food) {
    throw createError({ statusCode: 404, statusMessage: 'Food not found' })
  }

  if (food.owner_user_id !== id) {
    throw createError({ statusCode: 404, statusMessage: 'Food not found' })
  }

  if (food.source !== 'custom') {
    throw createError({ statusCode: 400, statusMessage: 'Only custom foods can be copied' })
  }

  // Copy the food into the current user's account
  const copiedId = copyCustomFoodInto(db, foodId, user.id)

  return { copiedFoodId: copiedId, friend }
})

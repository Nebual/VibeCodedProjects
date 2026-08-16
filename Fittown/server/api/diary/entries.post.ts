import { RECIPE_SOURCE } from '#shared/recipes'

/**
 * Log a food to a meal.
 *
 * The client sends either an explicit gram weight or a serving count plus the
 * label it came from; we always resolve and store grams, since that's the only
 * thing nutrient maths can use. The label is kept purely so the diary can
 * redisplay "2 × slice" rather than "56 g".
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const meal = assertMeal(body.meal)
  const foodId = assertId(body.food_id, 'food_id')

  const db = useDb()
  const food = db
    .prepare(
      'SELECT id, source, serving_grams FROM foods WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)',
    )
    .get(foodId, user.id) as
    | { id: number; source: string; serving_grams: number | null }
    | undefined

  if (!food) throw createError({ statusCode: 404, statusMessage: 'Food not found' })

  // An empty recipe has null nutrients by design, so logging it would add a row
  // that contributes nothing and reads as a bug. Say why instead.
  if (food.source === RECIPE_SOURCE && food.serving_grams === null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'This recipe has no ingredients yet',
    })
  }

  const grams = assertNumber(body.grams, 'grams', { min: 0.1, max: 20000 })
  const servingLabel = optionalText(body.serving_label, 60)
  const servingCount = optionalNumber(body.serving_count, 'serving_count', {
    min: 0.01,
    max: 1000,
  })

  const { next } = db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM diary_entries WHERE user_id = ? AND date = ? AND meal = ?',
    )
    .get(user.id, day, meal) as { next: number }

  const info = db
    .prepare(
      `INSERT INTO diary_entries
         (user_id, date, meal, food_id, grams, serving_label, serving_count, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(user.id, day, meal, foodId, grams, servingLabel, servingCount, next)

  return { id: Number(info.lastInsertRowid) }
})

import { RECIPE_LOG_SOURCE, RECIPE_SOURCE } from '#shared/recipes'
import { assertAdjustments } from '../../utils/adjustments'
import { friendSharesCustomFoods } from '../../utils/friends'
import { resolveLoggedGrams, snapshotRecipeForLog } from '../../utils/recipes'

/**
 * Log a food to a meal.
 *
 * The client sends either an explicit gram weight or a serving count plus the
 * label it came from; we always resolve and store grams, since that's the only
 * thing nutrient maths can use. The label is kept purely so the diary can
 * redisplay "2 × slice" rather than "56 g".
 *
 * Logging a **recipe** freezes it first: `snapshotRecipeForLog()` clones the
 * recipe and its ingredients into a `recipe_log` food, and the entry points at
 * the clone. Editing the recipe afterwards can no longer move a meal that has
 * already been eaten. The whole thing runs in one transaction — an entry
 * without its snapshot, or a snapshot without its entry, is corruption.
 *
 * `adjustments` are this meal's one-off changes: three eggs instead of four, no
 * bacon, extra cheese. They land on the frozen copy, so the recipe is untouched
 * and tomorrow's omelette is the omelette again.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const meal = assertMeal(body.meal)
  const foodId = assertId(body.food_id, 'food_id')

  const grams = assertNumber(body.grams, 'grams', { min: 0.1, max: 20000 })
  const servingLabel = optionalText(body.serving_label, 60)
  const servingCount = optionalNumber(body.serving_count, 'serving_count', {
    min: 0.01,
    max: 1000,
  })
  const adjustments = assertAdjustments(body.adjustments)

  return transact((db) => {
    const food = db
      .prepare('SELECT id, source, serving_grams, owner_user_id FROM foods WHERE id = ?')
      .get(foodId) as
      | { id: number; source: string; serving_grams: number | null; owner_user_id: number | null }
      | undefined

    if (!food) throw createError({ statusCode: 404, statusMessage: 'Food not found' })

    // A food owned by someone else is loggable only if it is a custom food the
    // owner shares with friends (friendship + the Custom foods toggle). A
    // friend's *recipe* is not: it has to be copied first, then logged as yours.
    // Anything else is kept out of reach — same 404 a stranger gets.
    if (food.owner_user_id !== null && food.owner_user_id !== user.id) {
      const allowed =
        food.source === 'custom'
        && friendSharesCustomFoods(db, user.id, food.owner_user_id)
      if (!allowed) throw createError({ statusCode: 404, statusMessage: 'Food not found' })
    }

    // A snapshot belongs to exactly one entry, which is what lets deleting the
    // entry delete it outright instead of reference-counting. Logging one a
    // second time would quietly break that, so it isn't offered: it is the
    // record of a past meal, not something to eat again.
    if (food.source === RECIPE_LOG_SOURCE) {
      throw createError({
        statusCode: 400,
        statusMessage: 'That is a record of a meal already logged. Log the recipe instead.',
      })
    }

    // An empty recipe has null nutrients by design, so logging it would add a
    // row that contributes nothing and reads as a bug. Say why instead.
    if (food.source === RECIPE_SOURCE && food.serving_grams === null) {
      throw createError({
        statusCode: 400,
        statusMessage: 'This recipe has no ingredients yet',
      })
    }

    if (adjustments.length > 0 && food.source !== RECIPE_SOURCE) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Only a recipe can be adjusted',
      })
    }

    let loggedFoodId = foodId
    let loggedGrams = grams

    if (food.source === RECIPE_SOURCE) {
      loggedFoodId = snapshotRecipeForLog(db, foodId, user.id, adjustments).id
      // The client sized its portion against the recipe as written. Three eggs
      // instead of four makes the frozen copy lighter, so "1 serving" is a
      // different number of grams — re-derived here so the server is the only
      // authority on what lands in the diary. A plain gram portion is left
      // exactly as the user typed it.
      loggedGrams = resolveLoggedGrams(db, loggedFoodId, servingLabel, servingCount) ?? grams
    }

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
      .run(user.id, day, meal, loggedFoodId, loggedGrams, servingLabel, servingCount, next)

    return { id: Number(info.lastInsertRowid) }
  })
})

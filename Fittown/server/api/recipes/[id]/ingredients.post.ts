import { MAX_INGREDIENTS, RECIPE_LOG_SOURCE, RECIPE_SOURCE } from '#shared/recipes'
import {
  findRecipe,
  nestingRefusal,
  nextIngredientOrder,
  recomputeRecipeAndDependents,
} from '../../../utils/recipes'

/**
 * Add an ingredient.
 *
 * The client sends the same shape the diary does — resolved grams plus the
 * label and count it came from — because the same portion picker produced it.
 *
 * `food_id` is optional. Omitting it (with `raw_text` instead) records a line
 * we have a name for but no nutrition: what the bulk importer produces when it
 * can't match "a lot of oregano" to anything with confidence.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const recipeId = assertId(getRouterParam(event, 'id'), 'recipe id')
  const body = await readBody<Record<string, unknown>>(event)

  const rawText = optionalText(body.raw_text, 200)
  const foodId = body.food_id === undefined || body.food_id === null
    ? null
    : assertId(body.food_id, 'food_id')

  if (foodId === null && rawText === null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'An ingredient needs either a food_id or raw_text',
    })
  }

  // Zero is allowed — see the note in the schema. An ingredient with no stated
  // amount contributes nothing rather than being guessed at.
  const grams = assertNumber(body.grams, 'grams', { min: 0, max: 20000 })
  const servingLabel = optionalText(body.serving_label, 60)
  const servingCount = optionalNumber(body.serving_count, 'serving_count', {
    min: 0.01,
    max: 1000,
  })
  const note = optionalText(body.note, 200)

  // An optional ingredient added now is a *suggestion* — "50 g bacon on top" —
  // so it starts switched off and the recipe's totals are the base dish. A
  // caller can say otherwise; nothing in the app currently does.
  const isOptional = body.is_optional ? 1 : 0
  const isIncluded = body.is_included === undefined
    ? (isOptional ? 0 : 1)
    : (body.is_included ? 1 : 0)
  // The constraint the schema can't carry: a required ingredient is always in.
  const included = isOptional ? isIncluded : 1

  return transact((db) => {
    const recipe = findRecipe(db, recipeId, user.id)
    if (!recipe) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

    if (foodId !== null) {
      const food = db
        .prepare(
          'SELECT id, source FROM foods WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)',
        )
        .get(foodId, user.id) as { id: number; source: string } | undefined

      if (!food) throw createError({ statusCode: 404, statusMessage: 'Food not found' })

      // A frozen meal is a record of something eaten, not a component.
      if (food.source === RECIPE_LOG_SOURCE) {
        throw createError({
          statusCode: 400,
          statusMessage: 'That is a record of a meal already logged, not a recipe.',
        })
      }

      // A recipe inside a recipe is allowed, within two limits: it must not
      // already contain this one, and the stack must not get too deep. Both are
      // checked here rather than left to the rollup, which would recurse for
      // ever on a cycle instead of refusing one.
      if (food.source === RECIPE_SOURCE) {
        const refusal = nestingRefusal(db, recipeId, foodId)
        if (refusal) throw createError({ statusCode: 400, statusMessage: refusal })
      }
    }

    const { count } = db
      .prepare('SELECT COUNT(*) AS count FROM recipe_ingredients WHERE recipe_food_id = ?')
      .get(recipeId) as { count: number }
    if (count >= MAX_INGREDIENTS) {
      throw createError({
        statusCode: 400,
        statusMessage: `A recipe can hold at most ${MAX_INGREDIENTS} ingredients`,
      })
    }

    const info = db
      .prepare(
        `INSERT INTO recipe_ingredients
           (recipe_food_id, food_id, grams, serving_label, serving_count,
            raw_text, note, sort_order, is_optional, is_included)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recipeId,
        foodId,
        grams,
        servingLabel,
        servingCount,
        rawText,
        note,
        nextIngredientOrder(db, recipeId),
        isOptional,
        included,
      )

    recomputeRecipeAndDependents(db, recipeId)
    return { id: Number(info.lastInsertRowid) }
  })
})

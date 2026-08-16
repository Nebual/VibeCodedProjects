import { createRecipeFood } from '../../utils/recipes'

/**
 * Start a new recipe.
 *
 * Created empty and immediately, so the editor always has a real id to hang
 * ingredients off — the alternative is holding a draft recipe in the client
 * across a trip to the food search, which loses the lot on a refresh.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const name = assertText(body.name, 'name', 200)
  const servings = body.servings === undefined
    ? 1
    : assertNumber(body.servings, 'servings', { min: 0.1, max: 100 })

  const id = transact((db) => createRecipeFood(db, user.id, name, servings))

  setResponseStatus(event, 201)
  return { id }
})

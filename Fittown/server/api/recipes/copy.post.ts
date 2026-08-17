import { isShareToken } from '#shared/friends'
import { requireSharedSection } from '../../utils/friends'
import { copyRecipeInto, findRecipe } from '../../utils/recipes'

/**
 * Take a copy of someone else's recipe.
 *
 * One route for both ways in — a friend's recipe list and a public share link —
 * because "add this to my recipes" has to mean the same thing either way, and
 * because that puts both authorisation checks side by side where they can be
 * read together:
 *
 *   { friend_id, recipe_id }  → they must be an accepted friend who shares recipes
 *   { token }                 → the link must exist and still be live
 *
 * The copy is deep (see `copyRecipeInto`): what you get back is yours to edit
 * and delete, and nothing you do to it touches theirs.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  return transact((db) => {
    let sourceId: number

    if (body.token !== undefined) {
      const token = body.token
      if (!isShareToken(token)) {
        throw createError({ statusCode: 404, statusMessage: 'No such recipe link' })
      }
      const share = db
        .prepare('SELECT food_id FROM recipe_shares WHERE token = ? AND revoked_at IS NULL')
        .get(token) as { food_id: number } | undefined
      if (!share) {
        throw createError({ statusCode: 410, statusMessage: 'This recipe is no longer shared' })
      }
      sourceId = Number(share.food_id)
    } else {
      const friendId = assertId(body.friend_id, 'friend_id')
      const recipeId = assertId(body.recipe_id, 'recipe_id')
      requireSharedSection(db, user.id, friendId, 'share_recipes')

      // Scoped to that friend, so a friendship can't be used as a key to a
      // recipe belonging to someone else entirely.
      if (!findRecipe(db, recipeId, friendId)) {
        throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })
      }
      sourceId = recipeId
    }

    const id = copyRecipeInto(db, sourceId, user.id)
    const copy = db.prepare('SELECT id, name FROM foods WHERE id = ?').get(id) as {
      id: number
      name: string
    }

    setResponseStatus(event, 201)
    return copy
  })
})

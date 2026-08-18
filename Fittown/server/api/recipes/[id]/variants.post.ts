import { uniqueCopyName } from '#shared/friends'
import { RECIPE_SOURCE } from '#shared/recipes'
import { assertAdjustments } from '../../../utils/adjustments'
import { cloneRecipe, findRecipe } from '../../../utils/recipes'

/**
 * Save a variant of a recipe: "the same, but with three eggs".
 *
 * A sibling, not a child. Variants share a `recipe_family_id` — whichever of
 * them was created first — so every one of them can reach the others, and
 * deleting the original doesn't orphan the rest.
 *
 * `adjustments` are optional. With them, this is the "keep what I just did"
 * button on the log screen; without them it's "start from a copy of this".
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'recipe id')
  const body = await readBody<Record<string, unknown>>(event)

  const requested = body.name === undefined || body.name === null
    ? null
    : assertText(body.name, 'name', 200)
  const adjustments = assertAdjustments(body.adjustments)

  return transact((db) => {
    const source = findRecipe(db, id, user.id)
    if (!source) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

    const taken = (
      db
        .prepare('SELECT name FROM foods WHERE owner_user_id = ? AND source = ?')
        .all(user.id, RECIPE_SOURCE) as { name: string }[]
    ).map((row) => row.name)

    // A name the user typed is used as typed, even if it collides — they can
    // see both in the list and rename either. Only the generated fallback is
    // made unique, because nobody chose it.
    const name = requested ?? uniqueCopyName(String(source.name), taken)

    const newId = cloneRecipe(db, id, user.id, {
      name,
      // The family it belongs to, not a new one: that is what links them.
      familyId: Number(source.recipe_family_id ?? id),
      adjustments,
    })

    return { id: newId }
  })
})

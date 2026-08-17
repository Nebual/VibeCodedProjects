import { requireSharedSection } from '../../../../utils/friends'
import { recipeDetail } from '../../../../utils/recipes'

/**
 * One of a friend's recipes, read-only.
 *
 * Exactly what the owner's own editor is drawn from, minus the ability to
 * write: the page it feeds offers "Add recipe" and "Log food", both of which
 * take a copy rather than touching this row. Editing someone else's recipe
 * would rewrite meals they have already logged — see AGENTS.md on recipes
 * having no nutrient snapshot.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'friend id')
  const recipeId = assertId(getRouterParam(event, 'recipeId'), 'recipe id')

  const db = useDb()
  const { friend } = requireSharedSection(db, user.id, id, 'share_recipes')

  const detail = recipeDetail(db, recipeId, id)
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'Recipe not found' })

  return { ...detail, friend }
})

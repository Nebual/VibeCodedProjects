import { recentExercises } from '../../utils/exercises'

/**
 * The activities this user logged most recently — the quick-access row above
 * the category grid. Ten is about what fits before it stops being a shortcut.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { results: recentExercises(useDb(), user.id, 10) }
})

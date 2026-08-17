import { friendPermissions, requireFriendship } from '../../../utils/friends'
import { summarise } from '../../../utils/summary'

/**
 * A friend's trends, filtered by what they agreed to share.
 *
 * Same query as your own `/api/summary` — one implementation, so the two
 * screens can't disagree about what a week of calories was — with the sections
 * they've switched off removed *here*, on the way out. The friend page hides
 * what it isn't given; this is what makes that hiding mean something.
 *
 * The whole thing isn't a 403 when one section is off: the page needs to know
 * which parts exist so it can say "Alice isn't sharing her weight" instead of
 * showing an empty chart.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'), 'friend id')
  const { from, to } = getQuery(event)

  const start = assertDate(from, 'from')
  const end = assertDate(to, 'to')
  if (start > end) {
    throw createError({ statusCode: 400, statusMessage: '`from` must be on or before `to`' })
  }

  const db = useDb()
  requireFriendship(db, user.id, id)
  const permissions = friendPermissions(db, id)

  const summary = summarise(db, id, start, end, 'chart')

  if (!permissions.share_calories) {
    summary.food = {}
    // The goal line belongs to the chart it is drawn on.
    ;(summary.goals as Record<string, unknown>).calorie_goal = null
  }
  if (!permissions.share_weight) {
    summary.weights = []
    summary.biometrics = []
    ;(summary.goals as Record<string, unknown>).goal_weight_kg = null
  }
  if (!permissions.share_exercise) {
    summary.workouts = {}
  }
  // Water has no switch of its own and no chart; it rides with the diary.
  summary.water = {}

  return { ...summary, permissions }
})

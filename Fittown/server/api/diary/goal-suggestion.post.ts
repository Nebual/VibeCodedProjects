/**
 * Record the user's answer to the "lower today's goal by 100 kcal?" nudge.
 *
 * Keyed by date rather than a row id — like weight — because there is only
 * ever one decision per day (`daily_goal_adjustments` has a
 * `PRIMARY KEY (user_id, date)`), and the diary already knows which day it's
 * asking about.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const action = body.action
  if (action !== 'accept' && action !== 'dismiss') {
    throw createError({ statusCode: 400, statusMessage: 'action must be "accept" or "dismiss"' })
  }

  setGoalAdjustment(useDb(), user.id, day, action === 'accept' ? 'accepted' : 'dismissed')

  return { ok: true }
})

/** The measurements this user has chosen to track, in display order. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)

  const types = useDb()
    .prepare(
      `SELECT id, name, unit, sort_order FROM biometric_types
       WHERE user_id = ? ORDER BY sort_order, id`,
    )
    .all(user.id)

  return { types }
})

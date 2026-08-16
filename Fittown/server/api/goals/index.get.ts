export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const goals = useDb().prepare('SELECT * FROM user_goals WHERE user_id = ?').get(user.id)
  return { goals }
})

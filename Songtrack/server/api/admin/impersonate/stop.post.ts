export default defineEventHandler(async (event) => {
  // Checks the REAL signed-in user, unaffected by any active impersonation.
  await requireAdmin(event)
  const session = await getUserSession(event)
  // replaceUserSession (not setUserSession) so impersonatingUserId is actually
  // dropped rather than merged over with undefined.
  await replaceUserSession(event, { user: session.user })
  return { ok: true }
})

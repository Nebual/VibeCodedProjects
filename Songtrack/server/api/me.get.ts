export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  return {
    user: actor.user,
    realUser: actor.realUser,
    isImpersonating: actor.isImpersonating,
  }
})

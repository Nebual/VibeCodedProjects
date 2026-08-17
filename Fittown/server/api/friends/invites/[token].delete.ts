import { isShareToken } from '#shared/friends'

/**
 * Cancel an invite link you sent.
 *
 * Marked revoked rather than deleted so that someone who opens a cancelled
 * link is told it was cancelled instead of being shown a bare 404 they'll read
 * as a bug in the app.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const token = getRouterParam(event, 'token')
  if (!isShareToken(token)) {
    throw createError({ statusCode: 404, statusMessage: 'No such invite' })
  }

  const info = useDb()
    .prepare(
      `UPDATE friend_invites SET revoked_at = datetime('now')
       WHERE token = ? AND inviter_id = ? AND revoked_at IS NULL`,
    )
    .run(token, user.id)

  if (info.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'No such invite' })
  }

  return { ok: true }
})

/**
 * Revoke a paired device. The token stops working immediately
 * (requireDevice checks revoked_at); the row itself is kept for the audit
 * trail rather than deleted.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = assertId(getRouterParam(event, 'id'))

  const info = useDb()
    .prepare(
      `UPDATE device_tokens SET revoked_at = datetime('now')
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .run(id, user.id)

  if (info.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Device not found' })
  }

  return { ok: true }
})

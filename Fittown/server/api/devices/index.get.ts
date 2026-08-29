/** Paired phones, for Settings -> Connected devices. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)

  const devices = useDb()
    .prepare(
      `SELECT id, name, created_at, last_used_at, last_sync_at, revoked_at
       FROM device_tokens
       WHERE user_id = ? AND token_hash IS NOT NULL
       ORDER BY created_at DESC`,
    )
    .all(user.id)

  return { devices }
})

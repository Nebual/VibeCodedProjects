import { appSettings } from '../../database/schema'
import { db } from '../../database/client'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readBody<{ signupsEnabled: boolean }>(event)
  const value = String(!!body.signupsEnabled)

  db.insert(appSettings).values({ key: 'signups_enabled', value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
    .run()

  return { ok: true }
})

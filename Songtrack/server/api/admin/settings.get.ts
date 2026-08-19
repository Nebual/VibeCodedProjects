import { eq } from 'drizzle-orm'
import { db } from '../../database/client'
import { appSettings } from '../../database/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const row = db.select().from(appSettings).where(eq(appSettings.key, 'signups_enabled')).get()
  return { signupsEnabled: row ? row.value === 'true' : true }
})

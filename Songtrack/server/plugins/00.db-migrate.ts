import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../database/client'
import { appSettings } from '../database/schema'

export default defineNitroPlugin(() => {
  migrate(db, { migrationsFolder: 'server/database/migrations' })

  const existing = db.select().from(appSettings).where(eq(appSettings.key, 'signups_enabled')).get()
  if (!existing) {
    db.insert(appSettings).values({ key: 'signups_enabled', value: 'true' }).run()
  }

  console.log('[songtrack] database ready')
})

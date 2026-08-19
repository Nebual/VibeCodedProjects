import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../database/client'
import { appSettings, users } from '../../database/schema'

export default defineOAuthGoogleEventHandler({
  config: {
    scope: ['email', 'profile'],
  },
  async onSuccess(event, { user: googleUser }) {
    const config = useRuntimeConfig()
    const email = String(googleUser.email)
    const isAdminEmail = email.toLowerCase() === config.adminEmail.toLowerCase()

    let user = db.select().from(users).where(eq(users.googleSub, googleUser.sub)).get()

    if (!user) {
      const signupsRow = db.select().from(appSettings).where(eq(appSettings.key, 'signups_enabled')).get()
      const signupsEnabled = signupsRow ? signupsRow.value === 'true' : true

      if (!signupsEnabled && !isAdminEmail) {
        return sendRedirect(event, '/signups-closed')
      }

      const now = new Date()
      const record = {
        id: nanoid(),
        googleSub: String(googleUser.sub),
        email,
        name: String(googleUser.name || email),
        avatarUrl: googleUser.picture ? String(googleUser.picture) : null,
        role: (isAdminEmail ? 'admin' : 'user') as 'admin' | 'user',
        status: (isAdminEmail ? 'approved' : 'pending') as 'pending' | 'approved' | 'rejected',
        approvedAt: isAdminEmail ? now : null,
        approvedBy: isAdminEmail ? 'system' : null,
        createdAt: now,
      }
      db.insert(users).values(record).run()
      user = record
    } else if (isAdminEmail && user.role !== 'admin') {
      // The designated admin email is promoted on sight even if it signed up
      // before being configured, or was previously demoted by mistake.
      db.update(users)
        .set({ role: 'admin', status: 'approved', approvedAt: user.approvedAt ?? new Date(), approvedBy: user.approvedBy ?? 'system' })
        .where(eq(users.id, user.id))
        .run()
      user = db.select().from(users).where(eq(users.id, user.id)).get()!
    }

    if (user.status === 'rejected') {
      return sendRedirect(event, '/access-denied')
    }

    await setUserSession(event, {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        role: user.role,
        status: user.status,
      },
    })

    return sendRedirect(event, '/')
  },
  onError(event, error) {
    console.error('[songtrack] Google OAuth error', error)
    return sendRedirect(event, '/login?error=oauth')
  },
})

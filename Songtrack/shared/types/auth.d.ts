import type { UserRole, UserStatus } from '#shared/types'

declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    name: string
    avatarUrl: string | null
    role: UserRole
    status: UserStatus
  }

  interface UserSession {
    // Set while an admin is viewing the app as another user. The signed-in
    // person is always `session.user`; this id names whose data to show.
    impersonatingUserId?: string
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface SecureSessionData {}
}

export {}

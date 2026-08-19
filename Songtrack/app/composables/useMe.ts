import type { UserRole, UserStatus } from '#shared/types'

export interface MeUser {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: UserRole
  status: UserStatus
}

export interface MeResponse {
  user: MeUser
  realUser: MeUser
  isImpersonating: boolean
}

export function useMe() {
  return useFetch<MeResponse>('/api/me', {
    key: 'me',
  })
}

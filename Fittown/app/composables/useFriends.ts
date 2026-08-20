import type { SharePermissions } from '#shared/sharing'
import type { RecipeSummary } from '~/composables/useRecipes'

/** Shapes the friends endpoints return. Kept here so pages agree on them. */

export interface FriendPerson {
  id: number
  name: string
  email: string
  avatar_url: string | null
}

export interface FriendEntry extends FriendPerson {
  friendship_id: number
  since: string | null
}

export interface PendingRequest extends FriendPerson {
  friendship_id: number
  created_at: string
}

export interface InviteRow {
  token: string
  note: string | null
  created_at: string
  expires_at: string
  revoked_at: string | null
}

export interface FriendsPayload {
  friends: FriendEntry[]
  incoming: PendingRequest[]
  outgoing: PendingRequest[]
  invites: InviteRow[]
}

export interface FriendProfile {
  friend: FriendPerson
  permissions: SharePermissions
}

export interface FriendRecipeList {
  friend: FriendPerson
  recipes: RecipeSummary[]
}

/**
 * A friend's custom foods — plain food rows (with owner_user_id = that friend),
 * listed for browsing and copying. The kilo/macros are null when they haven't
 * been recorded on a food; absent means unknown, not zero.
 */
export interface FriendCustomFood {
  id: number
  name: string
  brand: string | null
  is_liquid: number
  serving_grams: number | null
  kcal: number | null
  protein_g: number | null
  carbs_g: number | null
  fat_g: number | null
}

export interface FriendCustomFoodList {
  friend: FriendPerson
  foods: FriendCustomFood[]
}

/** A friend's recipe as it appears in food search — theirs, with a name on it. */
export interface FriendRecipeResult {
  id: number
  name: string
  source: string
  brand: string | null
  is_liquid: number
  kcal: number | null
  recipe_servings: number | null
  recipe_final_weight_g: number | null
  serving_grams: number | null
  owner_id: number
  owner_name: string
  owner_email: string
}

/** Pull a readable message out of a failed $fetch. */
export function apiError(err: unknown, fallback: string): string {
  const message = (err as { statusMessage?: string; data?: { statusMessage?: string } })
  return message?.data?.statusMessage ?? message?.statusMessage ?? fallback
}

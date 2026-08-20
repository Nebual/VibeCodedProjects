/**
 * What a friend is allowed to see.
 *
 * Accepting a friend request is one decision; handing over a food diary, a
 * weight history and a training log is five. These toggles live on
 * `user_goals` (one settings row per user, already there) and are read by
 * three places that must agree: the Settings screen that sets them, the API
 * routes that enforce them, and the friend view that decides what to draw.
 *
 * Enforcement is server-side. The friend screens hide what they aren't given,
 * but the deciding is done in `server/api/friends/**` — a hidden section is a
 * tidy UI, not a privacy control.
 */

export interface ShareToggle {
  /** Column on `user_goals`. */
  key: 'share_recipes' | 'share_diary' | 'share_weight' | 'share_calories' | 'share_exercise' | 'share_custom_foods'
  label: string
  /** What the toggle actually governs, in the words the friend view uses. */
  description: string
}

/**
 * In the order Settings lists them.
 *
 * All default to on: someone you deliberately accepted seeing your trends is
 * the point of the feature, and a Friends tab where every friend shows an
 * empty page reads as broken rather than as private.
 */
export const SHARE_TOGGLES: readonly ShareToggle[] = [
  {
    key: 'share_recipes',
    label: 'Recipes',
    description: 'Friends can read your recipes, copy them, and find them when searching foods.',
  },
  {
    key: 'share_custom_foods',
    label: 'Custom foods',
    description: 'Friends can find and copy your custom foods when searching.',
  },
  {
    key: 'share_diary',
    label: 'Food diary',
    description: 'Friends can see what you ate on a given day, meal by meal.',
  },
  {
    key: 'share_weight',
    label: 'Weight',
    description: 'Friends can see your weight trend and any body measurements you track.',
  },
  {
    key: 'share_calories',
    label: 'Calories',
    description: 'Friends can see your daily calorie intake chart.',
  },
  {
    key: 'share_exercise',
    label: 'Exercise',
    description: 'Friends can see the calories and time you log from training.',
  },
] as const

export type ShareKey = ShareToggle['key']

export const SHARE_KEYS: readonly ShareKey[] = SHARE_TOGGLES.map((t) => t.key)

export type SharePermissions = Record<ShareKey, boolean>

/**
 * Read the flags off a `user_goals` row.
 *
 * Absent means on, matching the column default — an older database that hasn't
 * been through the migration yet, or a partial row from a trimmed API
 * response, must not read as "everything is private" and quietly blank a
 * friend's page.
 */
export function sharePermissions(goals: Record<string, unknown> | null | undefined): SharePermissions {
  const out = {} as SharePermissions
  for (const key of SHARE_KEYS) {
    const value = goals?.[key]
    out[key] = value === undefined || value === null ? true : Boolean(Number(value))
  }
  return out
}

/** Has this person turned everything off? Worth saying so on their page. */
export function sharesNothing(permissions: SharePermissions): boolean {
  return SHARE_KEYS.every((key) => !permissions[key])
}

/** How many of the five are on — the one-line summary Settings shows. */
export function sharedCount(permissions: SharePermissions): number {
  return SHARE_KEYS.filter((key) => permissions[key]).length
}

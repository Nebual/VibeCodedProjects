/**
 * Which cards appear on the Diary page.
 *
 * One JSON column on `user_goals` (`diary_cards_hidden`, an array of hidden
 * card ids) rather than ten booleans: the default is "everything visible", so
 * null / empty means all on, and a hidden card is a deliberate act recorded
 * as one id. Three places must agree on the id list: the Settings screen that
 * sets it, the goals API that validates it, and the Diary page that hides.
 */

export interface DiaryCard {
  id:
    | 'summary'
    | 'breakfast'
    | 'lunch'
    | 'dinner'
    | 'snacks'
    | 'water'
    | 'fitness'
    | 'reminders'
    | 'body'
    | 'nutrition'
  label: string
}

/** In the order Settings lists them. */
export const DIARY_CARDS: readonly DiaryCard[] = [
  { id: 'summary', label: 'Calorie / Macros Summary' },
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  // 'snack', not 'snacks': this must match the meal key in MEAL_ORDER /
  // day.meals, which the Diary page indexes visibility by.
  { id: 'snack', label: 'Snacks' },
  { id: 'water', label: 'Water' },
  { id: 'fitness', label: 'Fitness' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'body', label: 'Body Measurements' },
  { id: 'nutrition', label: 'Full Nutrition' },
] as const

export type DiaryCardId = DiaryCard['id']

export const DIARY_CARD_IDS: readonly DiaryCardId[] = DIARY_CARDS.map((c) => c.id)

export type DiaryCardVisibility = Record<DiaryCardId, boolean>

/**
 * Turn a stored `diary_cards_hidden` value into per-card visibility.
 *
 * Anything unknown in the array is dropped (a card removed in a later version
 * must not wedge the parser), and absent/null means everything on — matching
 * the column default and older rows that predate the feature.
 */
export function diaryCardVisibility(
  hidden: unknown,
): DiaryCardVisibility {
  const list = Array.isArray(hidden) ? hidden : safeParse(hidden)
  const out = {} as DiaryCardVisibility
  for (const id of DIARY_CARD_IDS) out[id] = true
  if (!Array.isArray(list)) return out
  for (const raw of list) {
    if (
      typeof raw === 'string' &&
      (DIARY_CARD_IDS as readonly string[]).includes(raw)
    ) {
      out[raw as DiaryCardId] = false
    }
  }
  return out
}

function safeParse(value: unknown): unknown {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null // corrupt value reads as "all visible", never as a blank diary
  }
}

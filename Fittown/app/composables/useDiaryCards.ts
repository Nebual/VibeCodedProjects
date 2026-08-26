import {
  DIARY_CARDS,
  DIARY_CARD_IDS,
  diaryCardVisibility,
  type DiaryCardId,
  type DiaryCardVisibility,
} from '#shared/diaryCards'

/**
 * Which Diary cards the user has switched off, and how to switch them.
 *
 * The source of truth is `user_goals.diary_cards_hidden` (a JSON array of
 * hidden ids — server-side, so preferences follow the account between
 * devices). Reads are derived from whatever goals object the caller already
 * has, so the Diary page needs no extra fetch; writes PUT to /api/goals and
 * flip the local state first so the toggle feels instant.
 */
export function useDiaryCards(
  source: MaybeRefOrGetter<{ diary_cards_hidden?: string | null } | null | undefined>,
) {
  /** Read through the source whether it's a ref, a reactive object or a getter. */
  const read = () => toValue(source)?.diary_cards_hidden ?? null
  /** Write back, so both a plain ref and a reactive form record the change. */
  const write = (value: string | null) => {
    const target = toValue(source)
    if (!target) return
    if (isRef(source)) source.value.diary_cards_hidden = value
    else target.diary_cards_hidden = value
  }

  const visible = computed<DiaryCardVisibility>(() => diaryCardVisibility(read()))

  const busy = ref<DiaryCardId | null>(null)

  /**
   * Flip one card. Optimistic: the toggle moves at once, and on failure the
   * stored value is restored so UI and storage agree.
   */
  async function setHidden(id: DiaryCardId, hidden: boolean) {
    if (!toValue(source)) return
    const current = { ...visible.value }
    current[id] = !hidden
    const nextHidden = DIARY_CARD_IDS.filter((card) => !current[card])

    const previous = read()
    write(nextHidden.length ? JSON.stringify(nextHidden) : null)
    busy.value = id
    try {
      await $fetch('/api/goals', {
        method: 'PUT',
        body: { diary_cards_hidden: nextHidden },
      })
    } catch {
      write(previous) // revert; the toggle flips back
    } finally {
      busy.value = null
    }
  }

  /** Back to all-on: clears the stored list entirely. */
  async function showAll() {
    if (!toValue(source)) return
    const previous = read()
    write(null)
    busy.value = DIARY_CARD_IDS[0]
    try {
      await $fetch('/api/goals', {
        method: 'PUT',
        body: { diary_cards_hidden: [] },
      })
    } catch {
      write(previous)
    } finally {
      busy.value = null
    }
  }

  return { cards: DIARY_CARDS, visible, busy, setHidden, showAll }
}

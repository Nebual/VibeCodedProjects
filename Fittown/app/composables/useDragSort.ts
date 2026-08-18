import type { Ref } from 'vue'

/**
 * Drag-to-reorder a list, with Pointer Events and no library.
 *
 * The list reorders *live* under the finger — there is no floating ghost row —
 * which is both simpler and, on a phone, clearer: what you see is what will be
 * saved. `commit` is called once, on release, with the final order.
 *
 * Four things this has to get right, and each of them is the reason for a
 * specific line below:
 *
 * - **The end of the drag is listened for on `window`, not on the handle.** This
 *   was a bug: with the handlers on the handle, the drag only ends if the handle
 *   itself receives `pointerup`. `setPointerCapture` is supposed to guarantee
 *   that, but capture is lost when the captured element is moved in the DOM —
 *   which is precisely what reordering the list does — and the release then
 *   lands on whatever is under the pointer, with no handler on it. `dragging`
 *   stayed set, and the next move over any handle picked the drag back up, so
 *   rows followed the mouse until you clicked the handle again.
 * - **A move with no button held ends the drag.** Belt and braces for the same
 *   failure: if a release is missed for any other reason, the very next mouse
 *   move says so, because `buttons` is 0.
 * - **`touch-action: none` belongs on the handle only.** On the row, or the list,
 *   it kills the page scroll. The consumer applies it (see the handle in
 *   `pages/recipes/[id].vue`).
 * - **The drop target is worked out from live rectangles, not a snapshot.** The
 *   rows move as you drag, so a snapshot taken at `pointerdown` is wrong by the
 *   second swap. `document.elementFromPoint` is the other obvious approach and is
 *   worse: the element under the pointer is always the row being dragged.
 * - **Auto-scroll runs off an animation frame, not off `pointermove`.** Holding
 *   still at the edge of the screen fires no move events, so a ten-ingredient
 *   list on a 390 px phone could not be reordered at all.
 */
export function useDragSort<T>(
  items: Ref<T[]>,
  commit: (ordered: T[]) => void | Promise<void>,
) {
  /** Where the dragged row currently sits, or null when nothing is dragging. */
  const dragging = ref<number | null>(null)
  const container = ref<HTMLElement | null>(null)

  let pointerY = 0
  let frame = 0
  /** Which pointer started this, so a second finger can't steer it. */
  let pointerId: number | null = null
  /** Kept so capture can be released explicitly if it survived the drag. */
  let handle: HTMLElement | null = null
  /** How close to the top or bottom edge before the page starts scrolling. */
  const EDGE = 72
  const SPEED = 10

  function rows(): HTMLElement[] {
    if (!container.value) return []
    return [...container.value.querySelectorAll<HTMLElement>('[data-sort-row]')]
  }

  /** Which slot the pointer is asking for: the first row whose middle is below it. */
  function slotAt(y: number): number {
    const list = rows()
    for (let index = 0; index < list.length; index += 1) {
      const box = list[index]!.getBoundingClientRect()
      if (y < box.top + box.height / 2) return index
    }
    return Math.max(0, list.length - 1)
  }

  function moveItem(from: number, to: number) {
    if (from === to) return
    const next = [...items.value]
    const [row] = next.splice(from, 1)
    if (row === undefined) return
    next.splice(to, 0, row)
    items.value = next
    dragging.value = to
  }

  function autoScroll() {
    if (dragging.value === null) return
    const height = window.innerHeight
    if (pointerY < EDGE) window.scrollBy(0, -SPEED)
    else if (pointerY > height - EDGE) window.scrollBy(0, SPEED)
    // Re-evaluate after scrolling: the rows have moved relative to the pointer,
    // so the slot under it may have changed without the finger moving at all.
    if (dragging.value !== null) moveItem(dragging.value, slotAt(pointerY))
    frame = requestAnimationFrame(autoScroll)
  }

  function listen(on: boolean) {
    const method = on ? window.addEventListener : window.removeEventListener
    method('pointermove', onMove as EventListener, { passive: false } as never)
    method('pointerup', end as EventListener)
    method('pointercancel', end as EventListener)
    // A release outside the window never fires pointerup at all.
    method('blur', end as EventListener)
  }

  function onMove(event: PointerEvent) {
    if (dragging.value === null) return
    if (pointerId !== null && event.pointerId !== pointerId) return

    // The button is no longer held, so the release happened somewhere we never
    // heard about. This move *is* the end of the drag.
    if (event.buttons === 0) {
      void end()
      return
    }

    event.preventDefault()
    pointerY = event.clientY
    moveItem(dragging.value, slotAt(event.clientY))
  }

  async function end() {
    if (dragging.value === null) return
    dragging.value = null
    cancelAnimationFrame(frame)
    listen(false)
    if (handle && pointerId !== null && handle.hasPointerCapture?.(pointerId)) {
      handle.releasePointerCapture(pointerId)
    }
    handle = null
    pointerId = null
    await commit(items.value)
  }

  function onPointerDown(event: PointerEvent, index: number) {
    // Left button or touch only — a right-click drag isn't a gesture anyone
    // means — and never two drags at once.
    if (event.button !== 0 || dragging.value !== null) return

    dragging.value = index
    pointerY = event.clientY
    pointerId = event.pointerId
    handle = event.currentTarget as HTMLElement
    // Capture is still worth setting: for touch it keeps the gesture attached to
    // the handle rather than to whatever scrolls past under the finger. It is no
    // longer *relied* on, which is the fix.
    handle.setPointerCapture?.(event.pointerId)

    listen(true)
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(autoScroll)
  }

  /**
   * Move one row by hand, for the keyboard.
   *
   * The handle is focusable, so arrow keys have to do something; without this
   * the feature exists only for people who can drag.
   */
  async function nudge(index: number, by: -1 | 1) {
    const to = index + by
    if (to < 0 || to >= items.value.length) return
    moveItem(index, to)
    dragging.value = null
    await commit(items.value)
  }

  // A component unmounted mid-drag must not leave listeners on the window.
  onScopeDispose(() => {
    cancelAnimationFrame(frame)
    if (typeof window !== 'undefined') listen(false)
  })

  return { dragging, container, onPointerDown, nudge }
}

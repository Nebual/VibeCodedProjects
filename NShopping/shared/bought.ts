import type { Item } from './types'
import { CORRECTION_WINDOW } from './types'

/**
 * How long after ticking an item the opposite tap still reads as fixing a mis-tap.
 * Deliberately the same five seconds the list waits before re-sorting: inside that window
 * the row hasn't moved yet, so a tap that lands on it is a tap on the row you meant.
 */
export const FLIP_UNDO_WINDOW = 5000

/**
 * What an item should look like after being ticked off or put back.
 *
 * `undo` is the item as it stood *before* the flip this one may be reversing — a tick
 * followed a second later by an untick is a fumbled tap, and the point of holding on to
 * that snapshot is that the dates survive it. Without one, a stray tap rewrites "last
 * bought" to now, and the honest answer to "when did we last buy coffee" is gone for good;
 * the untick then rewrites `addedAt` too, so even re-ticking can't put it back.
 *
 * Everything else is left to the ordinary rules: a real tick records the purchase unless
 * it lands inside CORRECTION_WINDOW of the item being added, and putting something back on
 * the list is the moment it became something to buy again.
 */
export function nextBoughtState(item: Item, bought: boolean, at: number, undo?: Item | null): Item {
  const next: Item = { ...item, bought, stateAt: at, updatedAt: at }

  // Restoring `stateAt` alongside the dates is what keeps this from cascading: the item
  // ends up carrying the age it had before the fumble, so the *next* flip is judged on its
  // own merits rather than being read as an undo of an undo.
  if (undo && undo.bought === bought && at - item.stateAt < FLIP_UNDO_WINDOW) {
    next.addedAt = undo.addedAt
    next.boughtAt = undo.boughtAt
    next.stateAt = undo.stateAt
    return next
  }

  if (bought) {
    // Ticking something off moments after adding it is a correction, not a shopping trip.
    if (at - item.addedAt >= CORRECTION_WINDOW) next.boughtAt = at
  }
  else {
    // Back on the list: this is the moment it became something to buy again.
    next.addedAt = at
  }

  return next
}

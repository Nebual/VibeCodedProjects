/**
 * Colour and symbol tags for grocery items.
 *
 * A colour stands for an area of the store — green for produce, yellow for bread,
 * light blue for frozen — so the point of a colour is not decoration but *order*:
 * items sharing one are listed together, and the list ends up walking the aisles in
 * roughly the order you do. That makes `TAG_COLORS` a running order, not a palette;
 * reordering it reorders every list in the app.
 *
 * Symbols are orthogonal to that. They mark an item out within its group without
 * moving it, which is why they never take part in sorting.
 */

/** Declaration order is the aisle order. Untagged items sort ahead of all of these. */
export const TAG_COLORS = ['green', 'yellow', 'blue', 'orange', 'pink', 'purple', 'grey'] as const

export type TagColor = typeof TAG_COLORS[number]

export const TAG_SYMBOLS = ['star', 'other-store'] as const

export type TagSymbol = typeof TAG_SYMBOLS[number]

/**
 * Labels are the user's vocabulary, not the data model's. The ids stay generic so the
 * stored lists don't go stale if the shop does; rename here and nothing else moves.
 */
export const TAG_SYMBOL_LABELS: Record<TagSymbol, string> = {
  'star': 'Star',
  'other-store': 'Not at Costco',
}

/** Colours are named for what they look like — which store area each one means is the user's call. */
export const TAG_COLOR_LABELS: Record<TagColor, string> = {
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
  orange: 'Orange',
  pink: 'Pink',
  purple: 'Purple',
  grey: 'Grey',
}

/**
 * A tag edit. `undefined` leaves a facet alone and `null` clears it, so one call can set a
 * colour without disturbing a symbol, and "no change" stays distinguishable from "remove"
 * — which matters because these arrive in bulk, over a selection whose items don't already
 * agree with each other.
 */
export interface TagPatch {
  color?: TagColor | null
  symbol?: TagSymbol | null
}

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value)
}

export function isTagSymbol(value: unknown): value is TagSymbol {
  return typeof value === 'string' && (TAG_SYMBOLS as readonly string[]).includes(value)
}

/**
 * Sort key for a colour. Untagged comes back as -1 on purpose: something you have only
 * just typed has no aisle yet, and burying it at the bottom of the list is the one place
 * you would not think to look for it. An unrecognised colour — an older client's tag, say
 * — lands there too rather than vanishing into an arbitrary slot.
 */
export function tagRank(color: TagColor | undefined): number {
  return color ? (TAG_COLORS as readonly string[]).indexOf(color) : -1
}

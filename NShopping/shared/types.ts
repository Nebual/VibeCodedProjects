/** A single grocery item. Shared verbatim between client, server and the JSON files on disk. */
export interface Item {
  id: string
  name: string
  /** When the item last entered the "to buy" state. */
  addedAt: number
  bought: boolean
  /**
   * When the item was last genuinely bought. Stays untouched when an item is ticked off
   * within CORRECTION_WINDOW of being added — that is someone fixing a mistake, not shopping.
   */
  boughtAt: number | null
  /** When `bought` last flipped. Used to sort items that have never been genuinely bought. */
  stateAt: number
  /** Last-writer-wins clock for merging. */
  updatedAt: number
  /** Tombstone. Kept around so deletes propagate to other devices. */
  deleted?: boolean
}

export interface ListFile {
  version: 1
  name: string
  /** Bumped on every write, so pollers can short-circuit. */
  rev: number
  items: Item[]
}

export interface ListResponse {
  name: string
  rev: number
  /** Absent when the client passed a `rev` that is still current. */
  items?: Item[]
  unchanged?: boolean
  /** Server clock, used by clients to correct for device clock skew. */
  serverTime: number
}

/** Ticking an item off within this window of adding it is treated as undoing a mistake. */
export const CORRECTION_WINDOW = 20 * 60 * 1000

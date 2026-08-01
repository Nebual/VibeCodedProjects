import type { Item, ListResponse } from '#shared/types'
import { CORRECTION_WINDOW } from '#shared/types'

/** Marking things bought shouldn't yank rows out from under a tapping finger. */
const SORT_DELAY = 5000
/** Batch edits into one round trip, so a burst of ticks is a single request. */
const SYNC_DELAY = 3000
/** How often to look for other devices' changes. */
const POLL_INTERVAL = 4000

export type SyncState = 'idle' | 'pending' | 'syncing' | 'error'

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function useShoppingList(listName: string, options: { readOnly?: boolean } = {}) {
  const readOnly = options.readOnly ?? false

  const items = ref<Record<string, Item>>({})
  /**
   * Frozen display order. Toggling an item deliberately does *not* touch this;
   * `resort()` rewrites it once the user has been idle for SORT_DELAY.
   */
  const order = ref<string[]>([])
  const loaded = ref(false)
  const syncState = ref<SyncState>('idle')
  const rev = ref(-1)

  /** Difference between the server clock and this device's, so last-writer-wins is fair. */
  let skew = 0
  const now = () => Date.now() + skew

  /** Items edited locally but not yet accepted by the server. */
  const pending = new Map<string, Item>()

  let sortTimer: ReturnType<typeof setTimeout> | undefined
  let syncTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const live = computed(() => Object.values(items.value).filter(item => !item.deleted))

  function compare(a: Item, b: Item): number {
    if (a.bought !== b.bought) return a.bought ? 1 : -1
    // To buy: whatever was added most recently sits at the top, where you just typed it.
    if (!a.bought) return b.addedAt - a.addedAt
    // Bought: most recently bought first, fading away down the page.
    return (b.boughtAt ?? b.stateAt) - (a.boughtAt ?? a.stateAt)
  }

  /** Drops ids that no longer exist and slots genuinely new ones into their sorted position. */
  function reconcileOrder() {
    const byId = new Map(live.value.map(item => [item.id, item]))
    const kept = order.value.filter(id => byId.has(id))
    const known = new Set(kept)

    for (const item of live.value) {
      if (known.has(item.id)) continue
      let index = kept.findIndex(id => compare(item, byId.get(id)!) < 0)
      if (index === -1) index = kept.length
      kept.splice(index, 0, item.id)
      known.add(item.id)
    }

    order.value = kept
  }

  function resort() {
    order.value = [...live.value].sort(compare).map(item => item.id)
  }

  function scheduleSort() {
    clearTimeout(sortTimer)
    sortTimer = setTimeout(() => !disposed && resort(), SORT_DELAY)
  }

  const sorted = computed(() => {
    const byId = items.value
    return order.value.map(id => byId[id]).filter((item): item is Item => item != null && !item.deleted)
  })

  // ---------------------------------------------------------------- syncing

  function markDirty(item: Item) {
    // Backups are frozen server-side; don't queue writes that can only be rejected.
    if (readOnly) return
    pending.set(item.id, { ...item })
    syncState.value = 'pending'
    clearTimeout(syncTimer)
    syncTimer = setTimeout(() => void flush(), SYNC_DELAY)
  }

  /** Merges a server snapshot in, last-writer-wins. Local edits carry newer stamps, so they survive. */
  function applyRemote(remote: Item[]) {
    let dirty = false
    for (const incoming of remote) {
      const existing = items.value[incoming.id]
      if (existing && incoming.updatedAt <= existing.updatedAt) continue
      items.value[incoming.id] = incoming
      dirty = true
    }
    if (dirty) reconcileOrder()
  }

  async function flush(): Promise<void> {
    if (disposed || !pending.size) return
    const ops = [...pending.values()]
    pending.clear()
    syncState.value = 'syncing'

    try {
      const res = await $fetch<ListResponse>(`/api/lists/${listName}`, { method: 'POST', body: { ops } })
      skew = res.serverTime - Date.now()
      rev.value = res.rev
      if (res.items) applyRemote(res.items)
      syncState.value = pending.size ? 'pending' : 'idle'
    }
    catch {
      // Put the ops back, but never over a newer edit the user made while we were in flight.
      for (const op of ops) if (!pending.has(op.id)) pending.set(op.id, op)
      syncState.value = 'error'
      clearTimeout(syncTimer)
      syncTimer = setTimeout(() => void flush(), SYNC_DELAY * 2)
    }
  }

  async function pull(): Promise<void> {
    if (disposed) return
    try {
      const res = await $fetch<ListResponse>(`/api/lists/${listName}`, { query: { rev: rev.value } })
      skew = res.serverTime - Date.now()
      rev.value = res.rev
      if (res.items) applyRemote(res.items)
      if (syncState.value === 'error' && !pending.size) syncState.value = 'idle'
    }
    catch {
      if (loaded.value) syncState.value = 'error'
    }
    finally {
      loaded.value = true
    }
  }

  // ---------------------------------------------------------------- actions

  function addItem(rawName: string): Item | undefined {
    if (readOnly) return
    const name = rawName.trim().replace(/\s+/g, ' ')
    if (!name) return

    const existing = live.value.find(item => item.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      if (existing.bought) setBought(existing, false)
      return existing
    }

    const at = now()
    const item: Item = { id: newId(), name, addedAt: at, bought: false, boughtAt: null, stateAt: at, updatedAt: at }
    items.value[item.id] = item
    order.value = [item.id, ...order.value]
    markDirty(item)
    scheduleSort()
    return item
  }

  function setBought(item: Item, bought: boolean) {
    if (readOnly) return
    const at = now()
    const next: Item = { ...item, bought, stateAt: at, updatedAt: at }

    if (bought) {
      // Ticking something off moments after adding it is a correction, not a shopping trip.
      if (at - item.addedAt >= CORRECTION_WINDOW) next.boughtAt = at
    }
    else {
      // Back on the list: this is the moment it became something to buy again.
      next.addedAt = at
    }

    items.value[item.id] = next
    markDirty(next)
    scheduleSort()
  }

  function toggle(item: Item) {
    setBought(item, !item.bought)
  }

  /**
   * Puts an item back exactly as it was, timestamps and all. Used to undo a bulk match
   * without inventing a new "bought 0 minutes ago".
   */
  function restoreItem(snapshot: Item) {
    if (readOnly) return
    const next: Item = { ...snapshot, updatedAt: now() }
    items.value[next.id] = next
    if (!next.deleted && !order.value.includes(next.id)) order.value.push(next.id)
    markDirty(next)
    scheduleSort()
  }

  function deleteItem(item: Item) {
    if (readOnly) return
    const at = now()
    const next: Item = { ...item, deleted: true, updatedAt: at }
    items.value[item.id] = next
    order.value = order.value.filter(id => id !== item.id)
    markDirty(next)
  }

  // ---------------------------------------------------------------- lifecycle

  function onVisible() {
    if (document.visibilityState === 'visible') void pull()
  }

  /** Closing the tab mid-window shouldn't silently drop the last few ticks. */
  function flushOnExit() {
    if (!pending.size) return
    const body = JSON.stringify({ ops: [...pending.values()] })
    const sent = navigator.sendBeacon?.(`/api/lists/${listName}`, new Blob([body], { type: 'application/json' }))
    if (sent) pending.clear()
  }

  onMounted(async () => {
    window.addEventListener('pagehide', flushOnExit)
    await pull()
    resort()
    // A backup never changes, so there is nothing to poll for.
    if (readOnly) return
    pollTimer = setInterval(() => {
      // Skip while we have unsent edits — flush() brings back a fresh snapshot anyway.
      if (document.visibilityState === 'visible' && !pending.size) void pull()
    }, POLL_INTERVAL)
    document.addEventListener('visibilitychange', onVisible)
  })

  onBeforeUnmount(() => {
    flushOnExit()
    disposed = true
    clearTimeout(sortTimer)
    clearTimeout(syncTimer)
    clearInterval(pollTimer)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('pagehide', flushOnExit)
  })

  return { items, sorted, live, loaded, syncState, addItem, toggle, setBought, deleteItem, restoreItem, now }
}

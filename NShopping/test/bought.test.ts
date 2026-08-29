import { describe, expect, it } from 'vitest'
import type { Item } from '#shared/types'
import { CORRECTION_WINDOW } from '#shared/types'
import { FLIP_UNDO_WINDOW, nextBoughtState } from '#shared/bought'

const HOUR = 60 * 60 * 1000

/** An item bought an hour ago and put back on the list half an hour later. */
function item(overrides: Partial<Item> = {}): Item {
  return {
    id: 'a',
    name: 'Coffee',
    addedAt: 1000 * HOUR,
    bought: false,
    boughtAt: 900 * HOUR,
    stateAt: 1000 * HOUR,
    updatedAt: 1000 * HOUR,
    ...overrides,
  }
}

describe('nextBoughtState', () => {
  it('records the purchase when something is genuinely ticked off', () => {
    const before = item()
    const at = before.addedAt + CORRECTION_WINDOW
    const next = nextBoughtState(before, true, at)

    expect(next).toMatchObject({ bought: true, boughtAt: at, stateAt: at, updatedAt: at })
    expect(next.addedAt).toBe(before.addedAt)
  })

  it('leaves "last bought" alone for something ticked off just after being added', () => {
    const before = item()
    const at = before.addedAt + 60_000
    const next = nextBoughtState(before, true, at)

    expect(next.bought).toBe(true)
    expect(next.boughtAt).toBe(before.boughtAt)
  })

  it('re-dates an item put back on the list', () => {
    const before = item({ bought: true, stateAt: 1001 * HOUR })
    const at = 1002 * HOUR
    const next = nextBoughtState(before, false, at)

    expect(next).toMatchObject({ bought: false, addedAt: at, boughtAt: before.boughtAt })
  })
})

describe('nextBoughtState — flipping straight back', () => {
  it('restores the dates a mis-tap overwrote', () => {
    const before = item()
    const ticked = nextBoughtState(before, true, before.addedAt + HOUR)
    expect(ticked.boughtAt).not.toBe(before.boughtAt)

    const at = ticked.stateAt + 2000
    const undone = nextBoughtState(ticked, false, at, before)

    expect(undone).toMatchObject({
      bought: false,
      addedAt: before.addedAt,
      boughtAt: before.boughtAt,
      stateAt: before.stateAt,
    })
    // The merge clock still has to move, or the correction never reaches the other phone.
    expect(undone.updatedAt).toBe(at)
  })

  it('restores them the other way round too, when a mis-tap put something back', () => {
    const before = item({ bought: true, boughtAt: 900 * HOUR, addedAt: 800 * HOUR, stateAt: 900 * HOUR })
    const unticked = nextBoughtState(before, false, 1000 * HOUR)
    const reticked = nextBoughtState(unticked, true, unticked.stateAt + 2000, before)

    expect(reticked).toMatchObject({ bought: true, addedAt: before.addedAt, boughtAt: before.boughtAt })
  })

  it('treats a tap after the window as a real change of mind', () => {
    const before = item()
    const ticked = nextBoughtState(before, true, before.addedAt + HOUR)
    const at = ticked.stateAt + FLIP_UNDO_WINDOW
    const next = nextBoughtState(ticked, false, at, before)

    expect(next).toMatchObject({ bought: false, addedAt: at, boughtAt: ticked.boughtAt })
  })

  it('does not cascade: the flip after an undo is judged on its own merits', () => {
    const before = item()
    const ticked = nextBoughtState(before, true, before.addedAt + HOUR)
    const undone = nextBoughtState(ticked, false, ticked.stateAt + 2000, before)

    // Restoring `stateAt` is what makes this a fresh decision rather than an undo of an undo.
    const at = undone.updatedAt + 2000
    const next = nextBoughtState(undone, true, at, ticked)

    expect(next).toMatchObject({ bought: true, boughtAt: at, stateAt: at })
  })

  it('ignores a snapshot that is not the state being returned to', () => {
    const before = item()
    const ticked = nextBoughtState(before, true, before.addedAt + HOUR)
    const at = ticked.stateAt + 2000
    const next = nextBoughtState(ticked, false, at, ticked)

    expect(next).toMatchObject({ bought: false, addedAt: at })
  })
})

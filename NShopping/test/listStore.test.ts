import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '#shared/types'
import { backupNameFor } from '#shared/listName'

// The store reads its data directory once at import time, so point it somewhere disposable
// before the module is ever loaded.
const DATA_DIR = await fs.mkdtemp(path.join(tmpdir(), 'nshopping-test-'))
vi.stubEnv('NSHOPPING_DATA_DIR', DATA_DIR)

const { applyOps, getList, requireReadableListName, requireWritableListName } = await import('../server/utils/listStore')

afterAll(() => fs.rm(DATA_DIR, { recursive: true, force: true }))

let listName = ''
let counter = 0
beforeEach(() => {
  listName = `list-${counter++}`
})

// A realistic wall-clock stamp, not a tidy small number: the store prunes tombstones
// older than 30 days, and timestamps down at the epoch are all older than that.
const at = Date.now()
const item = (id: string, name: string, overrides: Partial<Item> = {}): Item => ({
  id, name, addedAt: at, bought: false, boughtAt: null, stateAt: at, updatedAt: at, ...overrides,
})

const names = (items: Item[]) => items.filter(i => !i.deleted).map(i => i.name).sort()
const read = (name: string) => fs.readFile(path.join(DATA_DIR, `${name}.json`), 'utf8').then(JSON.parse)
const exists = (name: string) => fs.access(path.join(DATA_DIR, `${name}.json`)).then(() => true, () => false)

describe('name guards', () => {
  it('lets backups be read but not written', () => {
    const backup = 'groceries.backup-2026-07-30'
    expect(requireReadableListName(backup)).toBe(backup)
    expect(() => requireWritableListName(backup)).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it('rejects traversal on both paths', () => {
    expect(() => requireReadableListName('../etc/passwd')).toThrowError(expect.objectContaining({ statusCode: 400 }))
    expect(() => requireWritableListName('../etc/passwd')).toThrowError(expect.objectContaining({ statusCode: 400 }))
  })
})

describe('getList', () => {
  it('treats a missing file as an empty list rather than an error', async () => {
    const list = await getList('never-written')
    expect(list).toMatchObject({ version: 1, name: 'never-written', rev: 0, items: [] })
  })

  it('survives a corrupt file', async () => {
    await fs.writeFile(path.join(DATA_DIR, 'corrupt.json'), '{ not json', 'utf8')
    await expect(getList('corrupt')).rejects.toThrow()
  })

  it('treats a structurally wrong file as empty', async () => {
    await fs.writeFile(path.join(DATA_DIR, 'weird.json'), '{"items":"nope"}', 'utf8')
    expect((await getList('weird')).items).toEqual([])
  })
})

describe('applyOps merging', () => {
  it('creates the list and file on first write', async () => {
    const list = await applyOps(listName, [item('a', 'Milk')])
    expect(list.rev).toBe(1)
    expect(names(list.items)).toEqual(['Milk'])
    expect(await exists(listName)).toBe(true)
  })

  it('leaves items the caller did not mention alone', async () => {
    await applyOps(listName, [item('a', 'Milk'), item('b', 'Eggs')])
    const list = await applyOps(listName, [item('c', 'Bread')])
    expect(names(list.items)).toEqual(['Bread', 'Eggs', 'Milk'])
  })

  it('ignores a write older than what is stored', async () => {
    await applyOps(listName, [item('a', 'Milk', { updatedAt: 500 })])
    const list = await applyOps(listName, [item('a', 'STALE', { updatedAt: 400 })])
    expect(names(list.items)).toEqual(['Milk'])
    expect(list.rev).toBe(1)
  })

  it('accepts a write newer than what is stored', async () => {
    await applyOps(listName, [item('a', 'Milk', { updatedAt: 500 })])
    const list = await applyOps(listName, [item('a', 'Whole milk', { updatedAt: 600 })])
    expect(names(list.items)).toEqual(['Whole milk'])
  })

  it('does not bump rev when nothing changed', async () => {
    await applyOps(listName, [item('a', 'Milk', { updatedAt: 500 })])
    const list = await applyOps(listName, [item('a', 'STALE', { updatedAt: 400 })])
    expect(list.rev).toBe(1)
  })

  it('keeps a delete from being resurrected by an equally old write', async () => {
    await applyOps(listName, [item('a', 'Milk', { updatedAt: at })])
    await applyOps(listName, [item('a', 'Milk', { updatedAt: at + 1, deleted: true })])
    const list = await applyOps(listName, [item('a', 'Milk', { updatedAt: at + 1 })])
    expect(list.items.find(i => i.id === 'a')?.deleted).toBe(true)
  })

  it('keeps tombstones so deletes reach other devices', async () => {
    await applyOps(listName, [item('a', 'Milk')])
    const list = await applyOps(listName, [item('a', 'Milk', { updatedAt: at + 1, deleted: true })])
    expect(list.items.find(i => i.id === 'a')).toMatchObject({ deleted: true })
  })

  it('serialises concurrent writes without losing any', async () => {
    const ops = Array.from({ length: 25 }, (_, i) => applyOps(listName, [item(`i${i}`, `Item ${i}`)]))
    await Promise.all(ops)
    const list = await getList(listName)
    expect(list.items).toHaveLength(25)
    expect(list.rev).toBe(25)
  })
})

describe('applyOps input hardening', () => {
  it('rejects a non-array body', async () => {
    await expect(applyOps(listName, { nope: true })).rejects.toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    )
  })

  it('rejects an oversized batch', async () => {
    const ops = Array.from({ length: 501 }, (_, i) => item(`i${i}`, 'x'))
    await expect(applyOps(listName, ops)).rejects.toThrowError(expect.objectContaining({ statusCode: 413 }))
  })

  it('skips malformed ops instead of storing them', async () => {
    const list = await applyOps(listName, [null, 'nope', {}, { id: 5 }, { id: 'a' }, item('b', 'Milk')])
    expect(names(list.items)).toEqual(['Milk'])
  })

  it('coerces junk field types to something safe', async () => {
    const list = await applyOps(listName, [{
      id: 'a', name: 'Milk', addedAt: 'soon', bought: 'yes', boughtAt: Number.NaN, stateAt: 7, updatedAt: null,
    }])
    expect(list.items[0]).toEqual({
      id: 'a', name: 'Milk', addedAt: 7, bought: true, boughtAt: null, stateAt: 7, updatedAt: 7,
    })
  })

  it('truncates absurdly long names', async () => {
    const list = await applyOps(listName, [item('a', 'x'.repeat(500))])
    expect(list.items[0]!.name).toHaveLength(200)
  })

  it('does not write a file for an empty op list', async () => {
    await applyOps(listName, [])
    expect(await exists(listName)).toBe(false)
  })
})

describe('daily backups', () => {
  const today = () => backupNameFor(listName, new Date())

  it('does not back up a list that did not exist yet', async () => {
    await applyOps(listName, [item('a', 'Milk')])
    expect(await exists(today())).toBe(false)
  })

  it('backs up before the first write of the day', async () => {
    await applyOps(listName, [item('a', 'Milk')])
    await applyOps(listName, [item('b', 'Eggs')])
    expect(await exists(today())).toBe(true)
  })

  it('captures the state from before that write', async () => {
    await applyOps(listName, [item('a', 'Milk')])
    await applyOps(listName, [item('b', 'Eggs')])
    expect(names((await read(today())).items)).toEqual(['Milk'])
    expect(names((await getList(listName)).items)).toEqual(['Eggs', 'Milk'])
  })

  it('backs up at most once a day however many writes follow', async () => {
    await applyOps(listName, [item('a', 'Milk')])
    for (let i = 0; i < 5; i++) await applyOps(listName, [item(`b${i}`, `Item ${i}`)])

    const backups = (await fs.readdir(DATA_DIR)).filter(f => f.startsWith(`${listName}.backup-`))
    expect(backups).toEqual([`${today()}.json`])
    expect(names((await read(today())).items)).toEqual(['Milk'])
  })

  it('leaves an existing backup untouched', async () => {
    await applyOps(listName, [item('a', 'Milk')])
    await applyOps(listName, [item('b', 'Eggs')])
    const first = await read(today())
    await applyOps(listName, [item('c', 'Bread')])
    expect(await read(today())).toEqual(first)
  })

  it('does not back up when the write changes nothing', async () => {
    await applyOps(listName, [item('a', 'Milk', { updatedAt: 500 })])
    await applyOps(listName, [item('a', 'STALE', { updatedAt: 400 })])
    expect(await exists(today())).toBe(false)
  })

  it('makes the backup readable like any other list', async () => {
    await applyOps(listName, [item('a', 'Milk')])
    await applyOps(listName, [item('b', 'Eggs')])
    expect(names((await getList(today())).items)).toEqual(['Milk'])
  })
})

describe('tags round-tripping', () => {
  it('stores a colour and a symbol', async () => {
    await applyOps(listName, [item('a', 'Kale', { color: 'green', symbol: 'star' })])
    expect((await getList(listName)).items[0]).toMatchObject({ color: 'green', symbol: 'star' })
  })

  it('drops a tag it cannot name rather than letting it ride along in the file', async () => {
    await applyOps(listName, [{ ...item('a', 'Kale'), color: 'chartreuse', symbol: 'wingdings' }])
    const stored = (await getList(listName)).items[0]!
    expect(stored).not.toHaveProperty('color')
    expect(stored).not.toHaveProperty('symbol')
  })

  // Absent and cleared have to look identical on disk, or last-writer-wins can't express
  // "the user took the colour off".
  it('clears a tag when a later op arrives without one', async () => {
    await applyOps(listName, [item('a', 'Kale', { color: 'green', updatedAt: 100 })])
    await applyOps(listName, [item('a', 'Kale', { updatedAt: 200 })])
    const stored = (await getList(listName)).items[0]!
    expect(stored).not.toHaveProperty('color')
    expect(JSON.stringify(stored)).not.toContain('color')
  })

  it('leaves the tag alone when a stale op loses the merge', async () => {
    await applyOps(listName, [item('a', 'Kale', { color: 'green', updatedAt: 200 })])
    await applyOps(listName, [item('a', 'Kale', { updatedAt: 100 })])
    expect((await getList(listName)).items[0]).toMatchObject({ color: 'green' })
  })

  it('keeps untagged items free of empty tag keys', async () => {
    await applyOps(listName, [item('a', 'Milk')])
    expect(await read(listName)).toMatchObject({ items: [expect.not.objectContaining({ color: expect.anything() })] })
  })
})

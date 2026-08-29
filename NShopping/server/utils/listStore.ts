import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
// Imported explicitly rather than relying on Nitro's auto-import, so this module can be
// unit tested outside the server runtime.
import { createError } from 'h3'
import type { Item, ListFile } from '#shared/types'
import { backupNameFor, isBackupName, isReadableListName, isValidListName } from '#shared/listName'
import { isTagColor, isTagSymbol } from '#shared/tags'

const DATA_DIR = process.env.NSHOPPING_DATA_DIR
  ? path.resolve(process.env.NSHOPPING_DATA_DIR)
  : path.resolve(process.cwd(), 'data/lists')

/** Tombstones are pruned once every device has surely seen them. */
const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000

/** Guard rails so one bad client can't fill the disk. */
const MAX_OPS_PER_REQUEST = 500
const MAX_ITEMS_PER_LIST = 2000
const MAX_NAME_LENGTH = 200

function fileFor(name: string) {
  return path.join(DATA_DIR, `${name}.json`)
}

/** For reads: live lists and their dated backups. */
export function requireReadableListName(raw: unknown): string {
  if (!isReadableListName(raw)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid list name' })
  }
  return raw
}

/** For writes: live lists only. Backups are frozen. */
export function requireWritableListName(raw: unknown): string {
  if (isBackupName(raw)) {
    throw createError({ statusCode: 403, statusMessage: 'Backups are read-only' })
  }
  if (!isValidListName(raw)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid list name' })
  }
  return raw
}

function emptyList(name: string): ListFile {
  return { version: 1, name, rev: 0, items: [] }
}

async function read(name: string): Promise<ListFile> {
  try {
    const raw = await fs.readFile(fileFor(name), 'utf8')
    const parsed = JSON.parse(raw) as ListFile
    if (!parsed || !Array.isArray(parsed.items)) return emptyList(name)
    return { version: 1, name, rev: Number(parsed.rev) || 0, items: parsed.items.map(sanitize).filter(Boolean) as Item[] }
  }
  catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyList(name)
    throw err
  }
}

async function write(list: ListFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(fileFor(list.name), `${JSON.stringify(list, null, 2)}\n`, 'utf8')
}

/**
 * Snapshots the list as it stood before today's first edit. COPYFILE_EXCL does the
 * "at most once a day" check and the copy in one atomic step: if today's backup already
 * exists it fails with EEXIST and we carry on. Callers must hold the list's write lock.
 */
async function backupOncePerDay(name: string): Promise<void> {
  const target = fileFor(backupNameFor(name, new Date()))
  try {
    await fs.copyFile(fileFor(name), target, constants.COPYFILE_EXCL)
  }
  catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    // EEXIST: already backed up today. ENOENT: brand new list, nothing worth keeping.
    if (code !== 'EEXIST' && code !== 'ENOENT') throw err
  }
}

/**
 * Serialises read-modify-write cycles per list within this process, so two
 * devices POSTing at the same moment can't lose each other's ops.
 */
const chains = new Map<string, Promise<unknown>>()

function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(name) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  chains.set(name, run.catch(() => {}))
  return run
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Never trust an incoming item — clients are just browsers. */
function sanitize(raw: unknown): Item | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<Item>
  if (typeof item.id !== 'string' || !item.id || item.id.length > 64) return null
  if (typeof item.name !== 'string') return null
  const stateAt = num(item.stateAt, 0)
  return {
    id: item.id,
    name: item.name.slice(0, MAX_NAME_LENGTH),
    addedAt: num(item.addedAt, stateAt),
    bought: Boolean(item.bought),
    boughtAt: typeof item.boughtAt === 'number' && Number.isFinite(item.boughtAt) ? item.boughtAt : null,
    stateAt,
    updatedAt: num(item.updatedAt, stateAt),
    // Unknown tags are dropped, not preserved. A tag the server can't name is one the
    // clients can't render either, and silently keeping it would let a typo'd colour
    // ride along in the file for ever.
    ...(isTagColor(item.color) ? { color: item.color } : {}),
    ...(isTagSymbol(item.symbol) ? { symbol: item.symbol } : {}),
    ...(item.deleted ? { deleted: true as const } : {}),
  }
}

function prune(items: Item[], now: number): Item[] {
  const kept = items.filter(item => !(item.deleted && now - item.updatedAt > TOMBSTONE_TTL))
  if (kept.length <= MAX_ITEMS_PER_LIST) return kept
  // Oldest tombstones go first, then the least recently touched items.
  return [...kept].sort((a, b) => Number(a.deleted) - Number(b.deleted) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_ITEMS_PER_LIST)
}

export function getList(name: string): Promise<ListFile> {
  return withLock(name, () => read(name))
}

/**
 * Merges per-item ops into the stored list, last-writer-wins on `updatedAt`.
 * Items the caller didn't mention are left completely alone, so concurrent
 * editors only clobber each other when they touch the very same item.
 *
 * `async` purely so the guards below reject rather than throwing synchronously. The
 * signature promises a promise, and a caller that holds one — rather than awaiting it
 * inside a `try` the way the route happens to — would otherwise never see a bad batch.
 */
export async function applyOps(name: string, ops: unknown): Promise<ListFile> {
  if (!Array.isArray(ops)) {
    throw createError({ statusCode: 400, statusMessage: 'ops must be an array' })
  }
  if (ops.length > MAX_OPS_PER_REQUEST) {
    throw createError({ statusCode: 413, statusMessage: 'Too many ops' })
  }

  return withLock(name, async () => {
    const list = await read(name)
    const byId = new Map(list.items.map(item => [item.id, item]))
    let changed = false

    for (const op of ops) {
      const incoming = sanitize(op)
      if (!incoming) continue
      const existing = byId.get(incoming.id)
      if (existing && incoming.updatedAt < existing.updatedAt) continue
      if (existing && incoming.updatedAt === existing.updatedAt && existing.deleted) continue
      byId.set(incoming.id, incoming)
      changed = true
    }

    if (!changed) return list

    await backupOncePerDay(name)

    const merged: ListFile = {
      version: 1,
      name,
      rev: list.rev + 1,
      items: prune([...byId.values()], Date.now()),
    }
    await write(merged)
    return merged
  })
}

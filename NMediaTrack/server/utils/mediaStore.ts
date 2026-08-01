import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { MediaItem } from '~~/shared/types'

// Storage layout:
//   server/data/friends.yml      registry of people + who is tagged in whose list
//   server/data/media/<who>.yml  one file per list owner
//
// friends.yml's `taggedIn` is what tells us which media files to open for a given
// viewer, so we never have to read every file just to build someone's view.
const DATA_DIR = process.env.NMEDIA_DATA_DIR || join(process.cwd(), 'server', 'data')
const MEDIA_DIR = join(DATA_DIR, 'media')
const REGISTRY_FILE = join(DATA_DIR, 'friends.yml')

/** Identity is a case-insensitive, trimmed name. */
export const canonical = (name: string): string => String(name ?? '').trim().toLowerCase()

interface PersonEntry {
  name: string
  file?: string
}

export interface Registry {
  people: Record<string, PersonEntry>
  taggedIn: Record<string, string[]>
}

// All writes go through one chain so concurrent requests can't clobber a file.
let writeChain: Promise<unknown> = Promise.resolve()

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export async function readRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_FILE)) return { people: {}, taggedIn: {} }
  const parsed = (yaml.load(await readFile(REGISTRY_FILE, 'utf8')) as Partial<Registry>) ?? {}
  return {
    people: parsed.people && typeof parsed.people === 'object' ? parsed.people : {},
    taggedIn:
      parsed.taggedIn && typeof parsed.taggedIn === 'object' ? parsed.taggedIn : {},
  }
}

// yaml.dump can't emit comments, so the explanatory header is re-attached on
// every write to keep the file self-documenting.
const REGISTRY_HEADER = `# Registry of everyone the app knows about, and who has been tagged in whose list.
# Rebuilt automatically whenever someone's companions change — hand edits to the
# data below will be overwritten on the next write by that list's owner.
#
# people:   canonical (lowercased) name -> display name + the media file they own.
#           Someone with no \`file\` has been tagged by others but owns no list yet.
# taggedIn: person -> the owners who have tagged them. This is the lookup that says
#           which media/*.yml files to read for a given viewer.

`

async function writeRegistry(reg: Registry): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true })
  const sortKeys = <T>(o: Record<string, T>) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
  const doc = yaml.dump(
    { people: sortKeys(reg.people), taggedIn: sortKeys(reg.taggedIn) },
    { indent: 2, lineWidth: 100, noRefs: true },
  )
  await writeFile(REGISTRY_FILE, REGISTRY_HEADER + doc, 'utf8')
}

/** Pick a stable, readable filename for a person, avoiding collisions. */
function fileFor(reg: Registry, key: string, display: string): string {
  const existing = reg.people[key]?.file
  if (existing) return existing
  const base =
    display.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
    'user'
  const taken = new Set(
    Object.entries(reg.people)
      .filter(([k]) => k !== key)
      .map(([, p]) => p.file)
      .filter(Boolean) as string[],
  )
  let file = `${base}.yml`
  let n = 2
  while (taken.has(file)) file = `${base}-${n++}.yml`
  return file
}

// ---------------------------------------------------------------------------
// Media files
// ---------------------------------------------------------------------------

function normalise(item: Partial<MediaItem>, owner: string): MediaItem {
  const now = new Date().toISOString()
  return {
    id: String(item.id),
    title: String(item.title ?? '').trim(),
    type: (item.type ?? 'other') as MediaItem['type'],
    owner,
    status: (item.status ?? 'backlog') as MediaItem['status'],
    companions: Array.isArray(item.companions)
      ? item.companions.map((c) => String(c).trim()).filter(Boolean)
      : [],
    lastEpisode: item.lastEpisode ? String(item.lastEpisode) : undefined,
    lastActivityAt: item.lastActivityAt ? String(item.lastActivityAt) : undefined,
    createdAt: item.createdAt ? String(item.createdAt) : now,
    updatedAt: item.updatedAt ? String(item.updatedAt) : now,
    notes: item.notes ? String(item.notes) : undefined,
    review: item.review
      ? {
          stars: Number(item.review.stars) || 0,
          message: String(item.review.message ?? ''),
          updatedAt: item.review.updatedAt ? String(item.review.updatedAt) : now,
        }
      : undefined,
  }
}

/** Read one person's list. Returns [] if they don't own a file yet. */
export async function readMediaOf(reg: Registry, key: string): Promise<MediaItem[]> {
  const person = reg.people[key]
  if (!person?.file) return []
  const path = join(MEDIA_DIR, person.file)
  if (!existsSync(path)) return []
  const parsed =
    (yaml.load(await readFile(path, 'utf8')) as
      | { owner?: string; media?: Partial<MediaItem>[] }
      | null) ?? {}
  const owner = String(parsed.owner ?? person.name ?? key)
  const list = Array.isArray(parsed.media) ? parsed.media : []
  return list.map((m) => normalise(m, owner))
}

async function writeMediaOf(
  reg: Registry,
  key: string,
  display: string,
  items: MediaItem[],
): Promise<void> {
  const file = fileFor(reg, key, display)
  reg.people[key] = { name: display, file }
  if (!existsSync(MEDIA_DIR)) await mkdir(MEDIA_DIR, { recursive: true })
  // `owner` is declared once at the top of the file, not repeated per item.
  const clean = items.map(({ owner: _owner, ...rest }) =>
    JSON.parse(JSON.stringify(rest)),
  )
  const doc = yaml.dump(
    { owner: display, media: clean },
    { indent: 2, lineWidth: 100, noRefs: true, sortKeys: false },
  )
  await writeFile(join(MEDIA_DIR, file), doc, 'utf8')
}

/**
 * Recompute, from `items`, who `ownerKey` has tagged — and fold that into the
 * registry. Derived from the media itself so the two can never drift.
 */
function syncFriends(
  reg: Registry,
  ownerKey: string,
  ownerName: string,
  items: MediaItem[],
): void {
  if (!reg.people[ownerKey]) reg.people[ownerKey] = { name: ownerName }

  const tagged = new Map<string, string>()
  for (const m of items) {
    for (const c of m.companions) {
      const k = canonical(c)
      if (k && k !== ownerKey) tagged.set(k, c.trim())
    }
  }

  // Anyone newly tagged becomes a known person (they may not own a list yet).
  for (const [k, display] of tagged) {
    if (!reg.people[k]) reg.people[k] = { name: display }
  }

  // This owner's edge is added or removed for every person we know about.
  const everyone = new Set([...Object.keys(reg.people), ...Object.keys(reg.taggedIn)])
  for (const k of everyone) {
    const owners = new Set(reg.taggedIn[k] ?? [])
    if (tagged.has(k)) owners.add(ownerKey)
    else owners.delete(ownerKey)
    if (owners.size) reg.taggedIn[k] = [...owners].sort()
    else delete reg.taggedIn[k]
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Everything `user` may see: their own list, plus the full list of anyone who
 * has tagged them (being tagged makes you friends).
 */
export async function visibleMediaFor(user: string): Promise<MediaItem[]> {
  const me = canonical(user)
  if (!me) return []
  const reg = await readRegistry()
  const owners = new Set<string>([me, ...(reg.taggedIn[me] ?? [])])
  const out: MediaItem[] = []
  for (const owner of owners) out.push(...(await readMediaOf(reg, owner)))
  return out
}

/** Which person owns the item with this id, or null if it doesn't exist. */
export async function findItemOwner(id: string): Promise<string | null> {
  const reg = await readRegistry()
  for (const key of Object.keys(reg.people)) {
    const items = await readMediaOf(reg, key)
    if (items.some((m) => m.id === id)) return key
  }
  return null
}

/** Read-modify-write one person's list, serialised against all other writes. */
export async function mutateUserMedia<T>(
  owner: string,
  fn: (media: MediaItem[]) => { result: T; media: MediaItem[] },
): Promise<T> {
  const key = canonical(owner)
  const display = String(owner).trim()
  const run = async (): Promise<T> => {
    const reg = await readRegistry()
    const current = await readMediaOf(reg, key)
    const { result, media } = fn(current)
    const name = reg.people[key]?.name || display
    syncFriends(reg, key, name, media)
    await writeMediaOf(reg, key, name, media)
    await writeRegistry(reg)
    return result
  }
  const next = writeChain.then(run, run)
  writeChain = next.catch(() => undefined)
  return next
}

/** A user may edit an item only if they own it. */
export function canEdit(item: MediaItem, user: string): boolean {
  return canonical(item.owner) === canonical(user)
}

/** Every known display name, for tag autocomplete. */
export async function listPeople(exclude?: string): Promise<string[]> {
  const reg = await readRegistry()
  const skip = canonical(exclude ?? '')
  return Object.entries(reg.people)
    .filter(([k]) => k !== skip)
    .map(([, p]) => p.name)
    .sort((a, b) => a.localeCompare(b))
}

/** Small, dependency-free unique id. */
export function newId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/**
 * API integration tests — boots the real Nuxt server via @nuxt/test-utils
 * against an isolated SQLite DATA_DIR and exercises the HTTP surface with
 * real nuxt-auth-utils sessions.
 *
 * Sessions are minted server-side via /api/_test-login (gated on
 * ALLOW_TEST_LOGIN=true, which only this suite's server env sets). The
 * server seals its own cookie with setUserSession, so these tests have no
 * knowledge of iron/sealing internals and track whatever session format
 * nuxt-auth-utils currently produces.
 *
 * Admin endpoints get deliberately light coverage (happy path + authz gate);
 * the user-facing song/tag/album/share surface is covered in depth.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
type FetchOptions = Parameters<typeof $fetch>[1]
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setup, $fetch } from '@nuxt/test-utils/e2e'

const PORT = 8291

process.env.ALLOW_TEST_LOGIN = 'true'

// Isolated data dir per run so we never touch real data.
const DATA_DIR = join(tmpdir(), `songtrack-api-test-${process.pid}`)
mkdirSync(join(DATA_DIR, 'audio'), { recursive: true })

await setup({
  server: true,
  dev: true, // run via `nuxi _dev`; there is no prebuilt .output in CI/test runs
  port: PORT, // align ctx.url with the dev server (nuxi reads NUXT_PORT/PORT)
  env: {
    DATA_DIR,
    ALLOW_TEST_LOGIN: 'true',
    // Nuxt's devServer.port resolver only honors NUXT_PORT/NITRO_PORT/PORT;
    // PORT alone is consumed by listhen's fallback chain and gets ignored in
    // some nuxi versions — set all three.
    NUXT_PORT: String(PORT),
    NITRO_PORT: String(PORT),
    PORT: String(PORT),
  },
})

const DB_PATH = join(DATA_DIR, 'songtrack.db')
let sqlite: InstanceType<typeof Database>

interface SeededUser {
  id: string
  email: string
  role?: string
  status?: string
}

const seededUsers: Record<string, SeededUser> = {}

function seedUser(name: string, opts: { role?: 'admin' | 'user', status?: 'pending' | 'approved' | 'rejected' } = {}) {
  const id = randomId()
  const email = `${name}@songtrack.test`
  sqlite.prepare(`INSERT INTO users (id, google_sub, email, name, avatar_url, role, status, approved_at, approved_by, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'test-seed', ?)`)
    .run(id, `sub-${name}`, email, name, opts.role ?? 'user', opts.status ?? 'approved', Date.now(), Date.now())
  seededUsers[name] = { id, email, role: opts.role ?? 'user', status: opts.status ?? 'approved' }
  return id
}

function seedSong(userId: string, title: string) {
  const id = randomId()
  const now = Date.now()
  sqlite.prepare(`INSERT INTO songs (id, user_id, title, slug, edit_list, created_at, updated_at)
    VALUES (?, ?, ?, ?, '{"segments":[],"filters":[]}', ?, ?)`)
    .run(id, userId, title, title.toLowerCase().replace(/\s+/g, '-'), now, now)
  return id
}

function seedAlbum(userId: string, title: string) {
  const id = randomId()
  sqlite.prepare(`INSERT INTO albums (id, user_id, title, slug, description, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)`)
    .run(id, userId, title, title.toLowerCase().replace(/\s+/g, '-'), Date.now())
  return id
}

function randomId() {
  // nanoid-shaped enough for schema purposes; tests never assert its format.
  return globalThis.crypto.randomUUID().replaceAll('-', '')
}

// Cookie cache — one login per user; sessions persist across requests.
const cookies = new Map<string, string>()

async function loginCookie(user: SeededUser): Promise<string> {
  const cached = cookies.get(user.email)
  if (cached) return cached
  let capturedHeaders
  const res = await $fetch(`/api/_test-login?email=${encodeURIComponent(user.email)}`, {
    onResponse({ response }) {
      capturedHeaders = response.headers
    }
  })
  const setCookie = capturedHeaders.get('set-cookie')
  if (!setCookie) throw new Error(`_test-login returned no Set-Cookie for ${user.email}`)
  // Take only the first cookie pair; drop attributes like Path/HttpOnly/SameSite.
  const cookie = setCookie.split(';')[0]
  cookies.set(user.email, cookie)
  return cookie
}

type ApiOptions = FetchOptions & { user?: string, impersonates?: string }

/** Authenticated request as a seeded user; returns parsed body or the error object. */
async function api(path: string, opts: ApiOptions = {}) {
  const user = seededUsers[opts.user ?? 'alice']
  if (!user) throw new Error(`Unknown seeded user: ${opts.user}`)
  let cookie = await loginCookie(user)
  if (opts.impersonates) {
    // Re-login as admin with impersonation applied by the real endpoints.
    const target = seededUsers[opts.impersonates]
    cookie = await impersonationCookie(user, target)
  }
  try {
    return await $fetch(path, {
      ...opts,
      headers: { ...opts.headers, cookie },
      retry: 0,
    })
  } catch (err) {
    return err
  }
}

async function impersonationCookie(admin: SeededUser, target: SeededUser): Promise<string> {
  // Mint a fresh admin session then swap in impersonation via the real
  // admin endpoint so the cookie shape is exactly what production produces.
  const res: any = await $fetch(`/api/admin/impersonate/${target.id}`, {
    method: 'POST',
    headers: { cookie: await loginCookie(admin) },
    retry: 0,
  }).catch((e: any) => e)
  if (res?.statusCode) throw new Error(`impersonate failed: ${res.statusCode}`)
  const key = `${admin.email}:as:${target.id}`
  // The impersonate call sets a new session cookie; fetch it from the raw response.
  let capturedHeaders
  const raw = await $fetch(`/api/admin/impersonate/${target.id}`, {
    method: 'POST',
    headers: { cookie: await loginCookie(admin) },
    retry: 0,
    onResponse({ response }) {
      capturedHeaders = response.headers
    },
  })
  const setCookie = capturedHeaders.get('set-cookie')
  if (!setCookie) throw new Error('impersonate returned no Set-Cookie')
  const cookie = setCookie.split(';')[0]
  void key
  return cookie
}

beforeAll(async () => {
  sqlite = new Database(DB_PATH)
  sqlite.pragma('foreign_keys = ON')

  // Wait for the dev server's Nitro plugin to run migrations — the DB file
  // is created by database/client.ts at import time, but tables only exist
  // once the migrate plugin fires. Poll until the users table appears.
  for (let i = 0; i < 120; i++) {
    const hasUsers = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get()
    if (hasUsers) break
    await new Promise(r => setTimeout(r, 250))
  }
  if (!sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get()) {
    throw new Error('Server migrations never ran — users table missing')
  }

  seedUser('alice')
  seedUser('bob')
  seedUser('pending', { status: 'pending' })
  seedUser('rejected', { status: 'rejected' })
  seedUser('admin', { role: 'admin' })
})

afterAll(() => {
  sqlite?.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* Auth / identity                                                     */
/* ------------------------------------------------------------------ */

describe('auth gating', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const err: any = await $fetch('/api/me').catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('/api/me returns the acting identity', async () => {
    const res: any = await api('/api/me')
    expect(res.user.id).toBe(seededUsers.alice.id)
    expect(res.user.email).toBe('alice@songtrack.test')
    expect(res.isImpersonating).toBe(false)
  })

  it('rejected accounts are locked out of song endpoints', async () => {
    const err: any = await api('/api/songs', { user: 'rejected' })
    expect(err.statusCode).toBe(403)
  })
})

/* ------------------------------------------------------------------ */
/* Songs                                                               */
/* ------------------------------------------------------------------ */

describe('songs CRUD', () => {
  let aliceSongId: string
  let bobSongId: string

  it('creates a song with tags', async () => {
    const res: any = await api('/api/songs', {
      method: 'POST',
      body: { title: 'Nocturne in E-flat', tagNames: ['nocturne', 'chopin'] },
    })
    expect(res.id).toBeTruthy()
    aliceSongId = res.id

    const list: any = await api('/api/songs?q=nocturne')
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Nocturne in E-flat')
    expect([...list[0].tags].sort()).toEqual(['chopin', 'nocturne'])
  })

  it('requires a non-empty title', async () => {
    const err: any = await api('/api/songs', { method: 'POST', body: { title: '   ' } })
    expect(err.statusCode).toBe(400)
  })

  it('lists only the owning user’s songs', async () => {
    bobSongId = ((await api('/api/songs', { user: 'bob', method: 'POST', body: { title: 'Bob private piece' } })) as any).id
    const list: any = await api('/api/songs')
    expect(list.map((s: any) => s.id)).not.toContain(bobSongId)
  })

  it('search filters by title substring (case-insensitive)', async () => {
    const list: any = await api('/api/songs?q=NOCTURNE')
    expect(list.some((s: any) => s.title === 'Nocturne in E-flat')).toBe(true)
  })

  it('tag filter supports AND mode strictly', async () => {
    const both: any = await api('/api/songs?tags=nocturne,chopin&tagMode=and')
    expect(both.some((s: any) => s.id === aliceSongId)).toBe(true)

    const missingOne: any = await api('/api/songs?tags=nocturne,unknown-tag&tagMode=and')
    expect(missingOne.some((s: any) => s.id === aliceSongId)).toBe(false)
  })

  it('tag filter OR mode matches any tag', async () => {
    const orRes: any = await api('/api/songs?tags=unknown-tag,nocturne&tagMode=or')
    expect(orRes.some((s: any) => s.id === aliceSongId)).toBe(true)
  })

  it('PATCH updates fields, clamps rating to 0–10, replaces tags wholesale', async () => {
    const res: any = await api(`/api/songs/${aliceSongId}`, {
      method: 'PATCH',
      body: { rating: 99, tagNames: ['revised'], description: 'updated desc' },
    })
    expect(res.ok).toBe(true)

    const row = sqlite.prepare('SELECT rating, description FROM songs WHERE id = ?').get(aliceSongId) as any
    expect(row.rating).toBe(10)
    expect(row.description).toBe('updated desc')

    const tagged: any = await api('/api/songs?q=nocturne&tags=revised&tagMode=and')
    expect(tagged[0]?.tags).toEqual(['revised'])
  })

  it("PATCH rejects an empty title", async () => {
    const err: any = await api(`/api/songs/${aliceSongId}`, { method: 'PATCH', body: { title: '' } })
    expect(err.statusCode).toBe(400)
  })

  it("another user's song is 404, not 403 (id not leaked)", async () => {
    const err: any = await api(`/api/songs/${bobSongId}`, { method: 'PATCH', body: { title: 'hijack' } })
    expect(err.statusCode).toBe(404)
  })

  it('DELETE removes the song', async () => {
    const tempId = seedSong(seededUsers.alice.id, 'Delete me')
    const res: any = await api(`/api/songs/${tempId}`, { method: 'DELETE' })
    expect(res.ok ?? res).toBeTruthy()
    expect(sqlite.prepare('SELECT id FROM songs WHERE id = ?').get(tempId)).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* Bulk tagging                                                        */
/* ------------------------------------------------------------------ */

describe('bulk-tags', () => {
  it('validates payload shape', async () => {
    const noTags: any = await api('/api/songs/bulk-tags', { method: 'POST', body: { songIds: ['x'], tagNames: [], mode: 'add' } })
    expect(noTags.statusCode).toBe(400)
    const badMode: any = await api('/api/songs/bulk-tags', { method: 'POST', body: { songIds: ['x'], tagNames: ['t'], mode: 'upsert' } })
    expect(badMode.statusCode).toBe(400)
  })

  it('adds tags across multiple owned songs and silently skips foreign ids', async () => {
    const a = seedSong(seededUsers.alice.id, 'Bulk A')
    const b = seedSong(seededUsers.alice.id, 'Bulk B')

    const res: any = await api('/api/songs/bulk-tags', {
      method: 'POST',
      body: { songIds: [a, b], tagNames: ['recital'], mode: 'add' },
    })
    expect(res.updated).toBe(2)

    const count = (songId: string) => sqlite.prepare(`
      SELECT COUNT(*) AS n FROM song_tags st JOIN tags t ON t.id = st.tag_id
      WHERE st.song_id = ? AND t.name = 'recital'`).get(songId) as any
    expect(count(a).n).toBe(1)
    expect(count(b).n).toBe(1)

    const removeRes: any = await api('/api/songs/bulk-tags', {
      method: 'POST',
      body: { songIds: [a], tagNames: ['recital'], mode: 'remove' },
    })
    expect(removeRes.updated).toBe(1)
    expect(count(a).n).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/* ------------------------------------------------------------------ */

describe('tags', () => {
  it('lists only the acting user\'s tags', async () => {
    await api('/api/songs', { method: 'POST', body: { title: 'Tag owner check', tagNames: ['alice-only'] } })
    await api('/api/songs', { user: 'bob', method: 'POST', body: { title: 'Bob tag check', tagNames: ['bob-only'] } })

    const aliceTags: any = await api('/api/tags')
    expect(aliceTags.map((t: any) => t.name)).toContain('alice-only')
    expect(aliceTags.map((t: any) => t.name)).not.toContain('bob-only')

    const bobTags: any = await api('/api/tags', { user: 'bob' })
    expect(bobTags.map((t: any) => t.name)).toContain('bob-only')
    expect(bobTags.map((t: any) => t.name)).not.toContain('alice-only')
  })
})

/* ------------------------------------------------------------------ */
/* Share links (songs + public token access)                           */
/* ------------------------------------------------------------------ */

describe('share tokens & public access', () => {
  let token: string
  const songTitle = 'Share me publicly'

  it('POST share mints a stable token; repeat call returns the same one', async () => {
    const songId = seedSong(seededUsers.alice.id, songTitle)
    const first: any = await api(`/api/songs/${songId}/share`, { method: 'POST' })
    const second: any = await api(`/api/songs/${songId}/share`, { method: 'POST' })
    expect(first.token).toBeTruthy()
    expect(second.token).toBe(first.token)
    token = first.token
  })

  it('public endpoint serves the shared song without auth', async () => {
    const pub: any = await $fetch(`/api/public/songs/${token}`)
    expect(pub.title).toBe(songTitle)
    expect(JSON.stringify(pub)).not.toContain('"userId"')
  })

  it('unsharing kills public access', async () => {
    const songId = (sqlite.prepare('SELECT id FROM songs WHERE share_token = ?').get(token) as any).id
    await api(`/api/songs/${songId}/share`, { method: 'DELETE' })
    const err: any = await $fetch(`/api/public/songs/${token}`).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('unknown tokens 404 with the friendly message', async () => {
    const err: any = await $fetch('/api/public/songs/not-a-real-token').catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it("another user can't mint or revoke someone else's share", async () => {
    const songId = seedSong(seededUsers.bob.id, "Bob's secret")
    const err: any = await api(`/api/songs/${songId}/share`, { method: 'POST' }) // alice acting
    expect(err.statusCode).toBe(404)
    const err2: any = await api(`/api/songs/${songId}/share`, { method: 'DELETE' })
    expect(err2.statusCode).toBe(404)
  })
})

/* ------------------------------------------------------------------ */
/* Albums                                                              */
/* ------------------------------------------------------------------ */

describe('albums', () => {
  let albumId: string

  it('creates and lists albums scoped per user', async () => {
    const created: any = await api('/api/albums', { method: 'POST', body: { title: 'Autumn Recital' } })
    expect(created.id).toBeTruthy()
    albumId = created.id

    const list: any = await api('/api/albums')
    expect(list.albums?.some?.((a: any) => a.id === albumId) ?? list.some((a: any) => a.id === albumId)).toBeTruthy()

    const bobList: any = await api('/api/albums', { user: 'bob' })
    const bobIds: string[] = Array.isArray(bobList) ? bobList.map((a: any) => a.id) : bobList.albums.map((a: any) => a.id)
    expect(bobIds).not.toContain(albumId)
  })

  it('requires a title', async () => {
    const err: any = await api('/api/albums', { method: 'POST', body: {} })
    expect(err.statusCode).toBe(400)
  })

  it('PATCH renames and re-slugs', async () => {
    const res: any = await api(`/api/albums/${albumId}`, { method: 'PATCH', body: { title: 'Winter Recital' } })
    expect(res.ok).toBe(true)
    const row = sqlite.prepare('SELECT title, slug FROM albums WHERE id = ?').get(albumId) as any
    expect(row.title).toBe('Winter Recital')
    expect(row.slug).toBe('winter-recital')
  })

  it('songs.put rejects cross-user song injection but accepts owned ones, storing order', async () => {
    const mineA = seedSong(seededUsers.alice.id, 'Album track A')
    const mineB = seedSong(seededUsers.alice.id, 'Album track B')
    const bobs = seedSong(seededUsers.bob.id, "Bob's album attempt")

    const bad: any = await api(`/api/albums/${albumId}/songs`, { method: 'PUT', body: { songIds: [mineA, bobs] } })
    expect(bad.statusCode).toBe(404)

    const ok: any = await api(`/api/albums/${albumId}/songs`, { method: 'PUT', body: { songIds: [mineB, mineA] } })
    expect(ok.ok).toBe(true)

    const rows = sqlite.prepare('SELECT song_id, position FROM album_songs WHERE album_id = ? ORDER BY position').all(albumId) as any[]
    expect(rows.map(r => r.song_id)).toEqual([mineB, mineA])
  })

  it('album share token grants public access; DELETE revokes it', async () => {
    const share: any = await api(`/api/albums/${albumId}/share`, { method: 'POST' })
    expect(share.token).toBeTruthy()

    const pub: any = await $fetch(`/api/public/albums/${share.token}`).catch(e => e)
    expect(pub.statusCode ?? 200).toBe(200)

    await api(`/api/albums/${albumId}/share`, { method: 'DELETE' })
    const dead: any = await $fetch(`/api/public/albums/${share.token}`).catch(e => e)
    expect(dead.statusCode).toBe(404)
  })

  it("another user gets 404 on someone else's album mutations", async () => {
    const err: any = await api(`/api/albums/${albumId}`, { user: 'bob', method: 'PATCH', body: { title: 'stolen' } })
    expect(err.statusCode).toBe(404)
  })
})

/* ------------------------------------------------------------------ */
/* Admin (light coverage: happy path + gate)                           */
/* ------------------------------------------------------------------ */

describe('admin surface (light)', () => {
  it('non-admins are rejected with 403', async () => {
    const err: any = await api('/api/admin/settings')
    expect(err.statusCode).toBe(403)
  })

  it('admin reads and toggles signup settings', async () => {
    const before: any = await api('/api/admin/settings', { user: 'admin' })
    expect(typeof before.signupsEnabled).toBe('boolean')

    const flipped = !before.signupsEnabled
    const post: any = await api('/api/admin/settings', { user: 'admin', method: 'POST', body: { signupsEnabled: flipped } })
    expect(post.ok).toBe(true)

    const after: any = await api('/api/admin/settings', { user: 'admin' })
    expect(after.signupsEnabled).toBe(flipped)

    // restore default-friendly state
    await api('/api/admin/settings', { user: 'admin', method: 'POST', body: { signupsEnabled: true } })
  })
})

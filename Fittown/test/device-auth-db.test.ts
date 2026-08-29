import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Device pairing and requireDevice() — the credential a phone uses instead of
 * a Google session, since Google OAuth refuses to run inside the Capacitor
 * WebView (docs/samsung-health-sync.md §3). Token hashing, revocation and the
 * 401 paths are the load-bearing part: the token is session-equivalent once
 * traded in at /auth/device, so getting these wrong is a real access-control
 * bug, not a cosmetic one.
 */

let dir: string
let dbPath: string

function installCreateError() {
  ;(globalThis as Record<string, unknown>).createError = (input: {
    statusCode: number
    statusMessage: string
  }) => Object.assign(new Error(input.statusMessage), input)
}

/** h3's getRequestHeader, close enough for these tests: reads a plain object. */
function installGetRequestHeader() {
  ;(globalThis as Record<string, unknown>).getRequestHeader = (
    event: { headers?: Record<string, string> },
    name: string,
  ) => event.headers?.[name.toLowerCase()]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-device-auth-'))
  dbPath = join(dir, 'test.db')
  process.env.FITTOWN_DB_PATH = dbPath
  installCreateError()
  installGetRequestHeader()
  vi.resetModules()
})

afterEach(() => {
  delete process.env.FITTOWN_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

async function boot() {
  vi.resetModules()
  installCreateError()
  installGetRequestHeader()
  const { useDb } = await import('../server/utils/db')
  return useDb()
}

const deviceAuth = () => import('../server/utils/deviceAuth')

function seedUser(db: DatabaseSync, id = 1) {
  db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id, `u${id}@test`, `User ${id}`)
  db.prepare('INSERT INTO user_goals (user_id) VALUES (?)').run(id)
}

function eventWithToken(token: string | null) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} } as never
}

describe('hashToken / generateToken', () => {
  it('hashes deterministically and different tokens hash differently', async () => {
    const { hashToken, generateToken } = await deviceAuth()
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
    expect(hashToken(a)).toBe(hashToken(a))
    expect(hashToken(a)).not.toBe(hashToken(b))
  })
})

describe('generatePairCode', () => {
  it('avoids visually ambiguous characters (0/O, 1/I)', async () => {
    const { generatePairCode } = await deviceAuth()
    for (let i = 0; i < 50; i++) {
      const code = generatePairCode()
      expect(code).toHaveLength(8)
      expect(code).not.toMatch(/[01OI]/)
    }
  })
})

describe('createPairCode', () => {
  it('inserts an unclaimed row a pairing code can later claim', async () => {
    const db = await boot()
    seedUser(db)
    const { createPairCode } = await deviceAuth()

    const { code, expiresAt } = createPairCode(db, 1, 'Phone (Google sign-in)')

    expect(code).toHaveLength(8)
    const row = db
      .prepare('SELECT user_id, name, token_hash, pair_code, pair_expires FROM device_tokens')
      .get() as {
      user_id: number
      name: string
      token_hash: string | null
      pair_code: string
      pair_expires: string
    }
    expect(row.user_id).toBe(1)
    expect(row.name).toBe('Phone (Google sign-in)')
    expect(row.token_hash).toBeNull() // unclaimed — see the schema comment
    expect(row.pair_code).toBe(code)
    expect(row.pair_expires).toBe(expiresAt)
  })

  it('defaults the name when the caller (e.g. Settings) does not supply one', async () => {
    const db = await boot()
    seedUser(db)
    const { createPairCode } = await deviceAuth()

    createPairCode(db, 1)

    const row = db.prepare('SELECT name FROM device_tokens').get() as { name: string }
    expect(row.name).toBe('Unnamed device')
  })

  it('two pairings for the same user can coexist unclaimed at once', async () => {
    // token_hash is NULL for both, and device_tokens.token_hash is UNIQUE —
    // this is exactly the case that column being nullable-and-unique exists
    // to allow (server/db/schema.ts's comment on it).
    const db = await boot()
    seedUser(db)
    const { createPairCode } = await deviceAuth()

    createPairCode(db, 1)
    createPairCode(db, 1)

    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM device_tokens WHERE user_id = 1').get() as {
        n: number
      }
    ).n
    expect(count).toBe(2)
  })
})

describe('requireDevice', () => {
  it('throws 401 with no Authorization header', async () => {
    const db = await boot()
    seedUser(db)
    const { requireDevice } = await deviceAuth()

    await expect(requireDevice(eventWithToken(null))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('throws 401 for a token that was never issued', async () => {
    const db = await boot()
    seedUser(db)
    const { requireDevice } = await deviceAuth()

    await expect(requireDevice(eventWithToken('not-a-real-token'))).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('resolves the device and user for a valid token, and stamps last_used_at', async () => {
    const db = await boot()
    seedUser(db)
    const { hashToken } = await deviceAuth()
    const token = 'a-valid-token'
    db.prepare(
      `INSERT INTO device_tokens (user_id, name, token_hash) VALUES (1, 'Phone', ?)`,
    ).run(hashToken(token))

    const { requireDevice } = await deviceAuth()
    const { device, user } = await requireDevice(eventWithToken(token))

    expect(device.name).toBe('Phone')
    expect(user.id).toBe(1)

    const row = db.prepare('SELECT last_used_at FROM device_tokens WHERE user_id = 1').get() as {
      last_used_at: string | null
    }
    expect(row.last_used_at).not.toBeNull()
  })

  it('throws 401 for a revoked token', async () => {
    const db = await boot()
    seedUser(db)
    const { hashToken } = await deviceAuth()
    const token = 'a-revoked-token'
    db.prepare(
      `INSERT INTO device_tokens (user_id, name, token_hash, revoked_at)
       VALUES (1, 'Phone', ?, datetime('now'))`,
    ).run(hashToken(token))

    const { requireDevice } = await deviceAuth()
    await expect(requireDevice(eventWithToken(token))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('a still-pending pairing row (token_hash NULL) never matches any bearer token', async () => {
    // token_hash is NULL while a pairing code is outstanding — SQLite's
    // `NULL = ?` is never true, but this pins that behaviour down rather than
    // trusting it implicitly.
    const db = await boot()
    seedUser(db)
    db.prepare(
      `INSERT INTO device_tokens (user_id, name, pair_code, pair_expires)
       VALUES (1, 'Unnamed device', 'ABCD1234', datetime('now', '+10 minutes'))`,
    ).run()

    const { requireDevice } = await deviceAuth()
    await expect(requireDevice(eventWithToken('anything-at-all'))).rejects.toMatchObject({
      statusCode: 401,
    })
  })
})

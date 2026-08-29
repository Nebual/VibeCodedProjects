import type { H3Event } from 'h3'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DbUser } from './auth'
import { useDb } from './db'

export interface DeviceRow {
  id: number
  user_id: number
  name: string
  revoked_at: string | null
}

const TOKEN_BYTES = 32
const PAIR_CODE_LENGTH = 8
const PAIR_CODE_TTL_MIN = 10
// No 0/O/1/I — a code is read off one phone and typed on another.
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The bearer token handed to the app once, at claim time. Never stored raw. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

export function generatePairCode(): string {
  let code = ''
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
    code += PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)]
  }
  return code
}

export function pairCodeExpiresAt(): string {
  return new Date(Date.now() + PAIR_CODE_TTL_MIN * 60_000).toISOString()
}

/**
 * Start a pairing: an unclaimed device_tokens row with a fresh code.
 *
 * Two callers: Settings' "Connect a phone" button (a signed-in browser asking
 * on the user's behalf), and the Google sign-in redirect for a request that
 * came from the app (`onSuccess` in server/routes/auth/google.get.ts, where
 * the user just proved who they are by finishing OAuth — see the comment
 * there for why that still goes through a pairing code rather than opening a
 * session directly). Both want the exact same row shape, so this is the one
 * place that creates one.
 */
export function createPairCode(
  db: DatabaseSync,
  userId: number,
  name = 'Unnamed device',
): { code: string; expiresAt: string } {
  const code = generatePairCode()
  const expiresAt = pairCodeExpiresAt()

  db.prepare(
    `INSERT INTO device_tokens (user_id, name, pair_code, pair_expires)
     VALUES (?, ?, ?, ?)`,
  ).run(userId, name, code, expiresAt)

  return { code, expiresAt }
}

/**
 * Resolve the paired device for a request carrying `Authorization: Bearer
 * <token>`, or throw 401.
 *
 * Deliberately separate from requireUser(): a device token is
 * session-equivalent once traded in at /auth/device (docs/samsung-health-sync.md
 * §3), so it is checked only by the two routes that need it — this one and
 * /auth/device — and never reaches the rest of the API directly.
 */
export async function requireDevice(
  event: H3Event,
): Promise<{ device: DeviceRow; user: DbUser }> {
  const header = getRequestHeader(event, 'authorization')
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null

  if (!token) {
    throw createError({ statusCode: 401, statusMessage: 'Missing device token' })
  }

  const db = useDb()
  const device = db
    .prepare(
      `SELECT id, user_id, name, revoked_at FROM device_tokens WHERE token_hash = ?`,
    )
    .get(hashToken(token)) as DeviceRow | undefined

  if (!device || device.revoked_at) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid or revoked device token' })
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(device.user_id) as
    | DbUser
    | undefined

  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Account no longer exists' })
  }

  db.prepare("UPDATE device_tokens SET last_used_at = datetime('now') WHERE id = ?").run(
    device.id,
  )

  return { device, user }
}

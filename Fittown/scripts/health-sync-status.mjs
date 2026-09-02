#!/usr/bin/env node
/**
 * Is the watch actually syncing? A terminal answer to the same question
 * Settings' "What the watch sent" panel answers in the browser
 * (docs/samsung-health-sync.md §2.1) — useful without signing in, e.g. over
 * SSH on the deployed server.
 *
 *   node scripts/health-sync-status.mjs [db-path] [--user email]
 *
 * Without --user, shows every household member. `classifyBasis()` is
 * imported from the app rather than reimplemented, so this can never show a
 * basis tally that disagrees with what the sync route itself decided.
 */
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { ensureSchema } from '../server/utils/db.ts'
import { classifyBasis } from '../server/utils/healthSync.ts'

const args = process.argv.slice(2)
const userFlag = args.indexOf('--user')
const userEmail = userFlag !== -1 ? args[userFlag + 1] : null
const dbFile = resolve(
  args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--user') ||
    process.env.FITTOWN_DB_PATH ||
    'data/fittown.db',
)

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 15000')
// Same reason every other maintenance script does this first: the app adds
// columns lazily on its first request, so a database copy that hasn't been
// served recently can be missing ones this script reads.
ensureSchema(db)
db.exec('PRAGMA foreign_keys = ON')

const users = db
  .prepare(
    userEmail
      ? 'SELECT id, email, name FROM users WHERE email = ?'
      : 'SELECT id, email, name FROM users ORDER BY id',
  )
  .all(...(userEmail ? [userEmail] : []))

if (users.length === 0) {
  console.log(userEmail ? `No user with email ${userEmail}.` : 'No users at all.')
  db.close()
  process.exit(userEmail ? 1 : 0)
}

for (const user of users) {
  console.log(`\n=== ${user.name} <${user.email}> ===`)

  const devices = db
    .prepare(
      `SELECT id, name, created_at, last_used_at, last_sync_at, revoked_at
       FROM device_tokens WHERE user_id = ? AND token_hash IS NOT NULL
       ORDER BY created_at DESC`,
    )
    .all(user.id)

  if (devices.length === 0) {
    console.log('No paired device.')
    continue
  }

  for (const d of devices) {
    const status = d.revoked_at ? `revoked ${d.revoked_at}` : 'active'
    console.log(
      `Device: ${d.name} (${status}) — paired ${d.created_at}, ` +
        `last used ${d.last_used_at ?? 'never'}, last synced ${d.last_sync_at ?? 'never'}`,
    )
  }

  const logs = db
    .prepare(
      `SELECT id, received_at, session_count, outcome, payload
       FROM health_sync_log WHERE user_id = ? ORDER BY id DESC LIMIT 10`,
    )
    .all(user.id)

  console.log(`\nLast ${logs.length} sync${logs.length === 1 ? '' : 's'}:`)
  if (logs.length === 0) {
    console.log('  (none yet — the phone app has never called /api/health/sync)')
  }
  for (const row of logs) {
    const basis = { device: 0, device_window: 0, estimated: 0 }
    try {
      const payload = JSON.parse(row.payload)
      for (const session of payload.sessions ?? []) {
        basis[classifyBasis(session.active_kcal, session.active_kcal_basis)]++
      }
    } catch {
      // Payload wasn't valid JSON — a malformed request rejected before
      // parsing. outcome already explains why.
    }
    const basisText =
      row.session_count > 0
        ? ` (${basis.device + basis.device_window} from the watch, ${basis.estimated} estimated)`
        : ''
    console.log(
      `  ${row.received_at}  ${row.outcome === 'ok' ? 'ok  ' : 'FAIL'}  ` +
        `${row.session_count} session${row.session_count === 1 ? '' : 's'}${basisText}` +
        (row.outcome === 'ok' ? '' : `  — ${row.outcome}`),
    )
  }

  const workouts = db
    .prepare(
      `SELECT w.date, w.calories, w.calorie_basis, w.duration_min, e.name AS exercise
       FROM workout_entries w JOIN exercises e ON e.id = w.exercise_id
       WHERE w.user_id = ? AND w.source = 'health_connect'
       ORDER BY w.date DESC, w.id DESC LIMIT 10`,
    )
    .all(user.id)

  console.log(`\nLast ${workouts.length} synced workout${workouts.length === 1 ? '' : 's'} in the diary:`)
  if (workouts.length === 0) {
    console.log('  (none yet)')
  }
  for (const w of workouts) {
    console.log(
      `  ${w.date}  ${w.exercise}  ${Math.round(w.duration_min ?? 0)} min  ` +
        `${Math.round(w.calories ?? 0)} kcal (${w.calorie_basis})`,
    )
  }

  const daily = db
    .prepare(
      `SELECT e.date, t.name, e.value
       FROM biometric_entries e JOIN biometric_types t ON t.id = e.type_id
       WHERE e.user_id = ? AND t.name IN ('Steps', 'Active calories')
       ORDER BY e.date DESC LIMIT 14`,
    )
    .all(user.id)

  console.log(`\nRecent daily figures:`)
  if (daily.length === 0) {
    console.log('  (none yet)')
  }
  for (const row of daily) {
    console.log(`  ${row.date}  ${row.name}: ${row.value}`)
  }
}

console.log()
db.close()

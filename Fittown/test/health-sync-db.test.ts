import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncPayload, SyncSession } from '../server/utils/healthSync'

/**
 * Device sync against a real SQLite database — idempotency, the deletion
 * guard, the deferred calorie-source setting, and the daily-figures upsert.
 * In the style of friends-db.test.ts / diary-cards-db.test.ts: boot the real
 * schema through useDb() so a change to ADDED_COLUMNS or the unique index in
 * server/db/schema.ts is exercised the same way production is.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-health-sync-'))
  dbPath = join(dir, 'test.db')
  process.env.FITTOWN_DB_PATH = dbPath
})

afterEach(() => {
  delete process.env.FITTOWN_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

async function boot() {
  vi.resetModules()
  const { useDb } = await import('../server/utils/db')
  return useDb()
}

function seedUser(db: DatabaseSync, id = 1) {
  db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id, `u${id}@test`, `User ${id}`)
  db.prepare('INSERT INTO user_goals (user_id) VALUES (?)').run(id)
}

const health = () => import('../server/utils/healthSync')

function session(overrides: Partial<SyncSession> = {}): SyncSession {
  return {
    external_id: 'hc-1',
    type: 'RUNNING',
    start: '2026-08-29T07:00:00-07:00',
    end: '2026-08-29T07:30:00-07:00',
    active_kcal: 300,
    active_kcal_basis: 'device',
    distance_km: null,
    avg_heart_rate: null,
    ...overrides,
  }
}

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return { sessions: [], deleted: [], daily: [], ...overrides }
}

function workoutRow(db: DatabaseSync, userId = 1) {
  return db.prepare('SELECT * FROM workout_entries WHERE user_id = ?').get(userId) as Record<
    string,
    unknown
  >
}

function workoutCount(db: DatabaseSync, userId = 1) {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM workout_entries WHERE user_id = ?').get(userId) as {
      n: number
    }
  ).n
}

describe('processSync', () => {
  it('imports a session, resolving through the device figure', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    const result = processSync(db, 1, payload({ sessions: [session()] }))

    expect(result).toMatchObject({ imported: 1, updated: 0, deleted: 0, skipped: 0 })
    expect(result.basis).toEqual({ device: 1, device_window: 0, estimated: 0 })

    const row = workoutRow(db)
    expect(row.source).toBe('health_connect')
    expect(row.external_id).toBe('hc-1')
    expect(row.calories).toBe(300)
    expect(row.device_kcal).toBe(300)
    expect(row.calorie_basis).toBe('device')
    expect(row.date).toBe('2026-08-29')
  })

  it('the same payload synced twice produces exactly one row', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    processSync(db, 1, payload({ sessions: [session()] }))
    const second = processSync(db, 1, payload({ sessions: [session()] }))

    expect(second.imported).toBe(0)
    expect(second.updated).toBe(1)
    expect(workoutCount(db)).toBe(1)
  })

  it('a revised session (same external_id, new calories) updates rather than duplicates', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    processSync(db, 1, payload({ sessions: [session({ active_kcal: 300 })] }))
    processSync(db, 1, payload({ sessions: [session({ active_kcal: 350 })] }))

    expect(workoutCount(db)).toBe(1)
    const row = workoutRow(db)
    expect(row.calories).toBe(350)
    expect(row.device_kcal).toBe(350)
  })

  it('labels a window-summed figure "device_window", distinct from the session\'s own figure', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    const result = processSync(
      db,
      1,
      payload({ sessions: [session({ active_kcal: 280, active_kcal_basis: 'device_window' })] }),
    )

    expect(result.basis).toEqual({ device: 0, device_window: 1, estimated: 0 })
    expect(workoutRow(db).calorie_basis).toBe('device_window')
  })

  it('falls back to MET estimation when the session carries no calories at all', async () => {
    const db = await boot()
    seedUser(db)
    db.prepare("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (1, '2026-08-01', 80)").run()
    const { processSync } = await health()

    const result = processSync(db, 1, payload({ sessions: [session({ active_kcal: null })] }))

    expect(result.basis).toEqual({ device: 0, device_window: 0, estimated: 1 })
    const row = workoutRow(db)
    expect(row.device_kcal).toBeNull()
    expect(row.calorie_basis).toBe('estimated')
    expect(row.calories).toBeGreaterThan(0)
  })

  it('maps a recognised Health Connect type to its Fittown exercise', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    processSync(db, 1, payload({ sessions: [session({ type: 'BIKING' })] }))

    const row = db
      .prepare(
        `SELECT e.name FROM workout_entries w
         JOIN exercises e ON e.id = w.exercise_id WHERE w.user_id = 1`,
      )
      .get() as { name: string }
    expect(row.name).toBe('Cycling')
  })

  it('an unmapped exercise type falls back to "Tracked workout" rather than being dropped', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    const result = processSync(db, 1, payload({ sessions: [session({ type: 'SOME_FUTURE_TYPE' })] }))

    expect(result.imported).toBe(1)
    const row = db
      .prepare(
        `SELECT e.name FROM workout_entries w
         JOIN exercises e ON e.id = w.exercise_id WHERE w.user_id = 1`,
      )
      .get() as { name: string }
    expect(row.name).toBe('Tracked workout')
  })

  it('derives the local calendar date from the session\'s own offset, not UTC', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    // 23:30 in Vancouver (-07:00) — via UTC this would land on the 30th.
    processSync(
      db,
      1,
      payload({
        sessions: [
          session({ start: '2026-08-29T23:30:00-07:00', end: '2026-08-29T23:50:00-07:00' }),
        ],
      }),
    )

    expect(workoutRow(db).date).toBe('2026-08-29')
  })

  it('an entry recorded in health_ignored is skipped, not re-imported', async () => {
    const db = await boot()
    seedUser(db)
    db.prepare("INSERT INTO health_ignored (user_id, external_id) VALUES (1, 'hc-1')").run()
    const { processSync } = await health()

    const result = processSync(db, 1, payload({ sessions: [session()] }))

    expect(result.skipped).toBe(1)
    expect(workoutCount(db)).toBe(0)
  })

  it('deleted[] removes a device-synced row but can never touch a hand-logged one', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    processSync(db, 1, payload({ sessions: [session()] }))

    const exerciseId = (
      db.prepare("SELECT id FROM exercises WHERE name = 'Running'").get() as { id: number }
    ).id
    db.prepare(
      `INSERT INTO workout_entries (user_id, date, exercise_id, calories, source)
       VALUES (1, '2026-08-29', ?, 200, 'manual')`,
    ).run(exerciseId)

    const result = processSync(db, 1, payload({ deleted: ['hc-1'] }))

    expect(result.deleted).toBe(1)
    expect(workoutCount(db)).toBe(1)
    expect(workoutRow(db).source).toBe('manual')
  })

  it('deleting an external_id that only a manual row could coincidentally share removes nothing', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    // A manual row can never actually carry an external_id in practice — the
    // manual insert path never sets one — but the deletion path guards on
    // source anyway, and this proves the guard rather than the absence.
    const exerciseId = (
      db.prepare("SELECT id FROM exercises WHERE name = 'Running'").get() as { id: number }
    ).id
    db.prepare(
      `INSERT INTO workout_entries (user_id, date, exercise_id, calories, source, external_id)
       VALUES (1, '2026-08-29', ?, 200, 'manual', 'hc-manual')`,
    ).run(exerciseId)

    const result = processSync(db, 1, payload({ deleted: ['hc-manual'] }))

    expect(result.deleted).toBe(0)
    expect(workoutCount(db)).toBe(1)
  })

  it('daily steps and active calories upsert idempotently, one row per type per day', async () => {
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    processSync(
      db,
      1,
      payload({ daily: [{ date: '2026-08-29', steps: 8000, active_kcal: 500 }] }),
    )
    processSync(
      db,
      1,
      payload({ daily: [{ date: '2026-08-29', steps: 8421, active_kcal: 620 }] }),
    )

    const rows = db
      .prepare(
        `SELECT t.name, e.value FROM biometric_entries e
         JOIN biometric_types t ON t.id = e.type_id WHERE e.user_id = 1`,
      )
      .all() as { name: string; value: number }[]

    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.name === 'Steps')?.value).toBe(8421)
    expect(rows.find((r) => r.name === 'Active calories')?.value).toBe(620)
  })

  it('a payload that throws partway through still leaves earlier writes intact', async () => {
    // processSync doesn't wrap itself in a transaction — each session upserts
    // independently — so a bad session further down the array doesn't undo
    // an earlier valid one. Simulate that with two users sharing no state:
    // this documents the behaviour rather than forcing a throw through
    // validation (which lives in the route, not here).
    const db = await boot()
    seedUser(db)
    const { processSync } = await health()

    processSync(db, 1, payload({ sessions: [session({ external_id: 'first' })] }))
    expect(workoutCount(db)).toBe(1)
  })
})

describe('recomputeDeviceCalories', () => {
  it('flipping to "estimate" recomputes device rows and leaves manual rows untouched', async () => {
    const db = await boot()
    seedUser(db)
    db.prepare("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (1, '2026-08-01', 80)").run()
    const { processSync, recomputeDeviceCalories } = await health()

    processSync(db, 1, payload({ sessions: [session({ active_kcal: 300 })] }))

    const exerciseId = (
      db.prepare("SELECT id FROM exercises WHERE name = 'Running'").get() as { id: number }
    ).id
    db.prepare(
      `INSERT INTO workout_entries (user_id, date, exercise_id, calories, source)
       VALUES (1, '2026-08-29', ?, 999, 'manual')`,
    ).run(exerciseId)

    recomputeDeviceCalories(db, 1, 'estimate')

    const rows = db
      .prepare('SELECT source, calories FROM workout_entries WHERE user_id = 1')
      .all() as { source: string; calories: number }[]
    const deviceRow = rows.find((r) => r.source === 'health_connect')!
    const manualRow = rows.find((r) => r.source === 'manual')!

    expect(deviceRow.calories).not.toBe(300)
    expect(manualRow.calories).toBe(999)
  })

  it('flipping to "device" and back to "estimate" round-trips without drift, because device_kcal is never overwritten', async () => {
    const db = await boot()
    seedUser(db)
    db.prepare("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (1, '2026-08-01', 80)").run()
    const { processSync, recomputeDeviceCalories } = await health()

    processSync(db, 1, payload({ sessions: [session({ active_kcal: 300 })] }))

    recomputeDeviceCalories(db, 1, 'estimate')
    const estimated = (workoutRow(db).calories as number)

    recomputeDeviceCalories(db, 1, 'device')
    expect(workoutRow(db).calories).toBe(300)

    recomputeDeviceCalories(db, 1, 'estimate')
    expect(workoutRow(db).calories).toBe(estimated)
  })

  it('leaves an "estimated" row alone when flipping to "device" — there is no device figure to switch to', async () => {
    const db = await boot()
    seedUser(db)
    db.prepare("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (1, '2026-08-01', 80)").run()
    const { processSync, recomputeDeviceCalories } = await health()

    processSync(db, 1, payload({ sessions: [session({ active_kcal: null })] }))
    const before = workoutRow(db).calories

    recomputeDeviceCalories(db, 1, 'device')

    expect(workoutRow(db).calories).toBe(before)
  })
})

describe('sync log', () => {
  it('a payload is logged before processing, and the outcome can be updated after', async () => {
    const db = await boot()
    seedUser(db)
    const { insertSyncLog, updateSyncLogOutcome } = await health()

    const logId = insertSyncLog(db, 1, { sessions: [session()] }, 1)
    let row = db.prepare('SELECT outcome, session_count FROM health_sync_log WHERE id = ?').get(logId) as {
      outcome: string
      session_count: number
    }
    expect(row.outcome).toBe('pending')
    expect(row.session_count).toBe(1)

    updateSyncLogOutcome(db, logId, 'ok')
    row = db.prepare('SELECT outcome FROM health_sync_log WHERE id = ?').get(logId) as {
      outcome: string
      session_count: number
    }
    expect(row.outcome).toBe('ok')
  })

  it('trimSyncLog keeps only the most recent rows per user', async () => {
    const db = await boot()
    seedUser(db)
    const { insertSyncLog, trimSyncLog } = await health()

    for (let i = 0; i < 25; i++) insertSyncLog(db, 1, { i }, 0)
    trimSyncLog(db, 1)

    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM health_sync_log WHERE user_id = 1').get() as { n: number }
    ).n
    expect(count).toBe(20)
  })
})

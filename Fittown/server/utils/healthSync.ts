import type { DatabaseSync } from 'node:sqlite'
import { estimateCalories } from '#shared/activities'
import { FALLBACK_WEIGHT_KG } from '#shared/body'
import { mapHealthConnectType } from '#shared/healthConnect'

/**
 * Device sync: importing Health Connect data into workout_entries and
 * biometric_entries, and the reversible calorie-source setting that recomputes
 * over it. See docs/samsung-health-sync.md, especially §2.1 (the calorie
 * cascade) and §4 (why the schema looks the way it does).
 *
 * Deliberately free of createError/H3 calls: the route (server/api/health/sync.post.ts)
 * validates the raw request body into the typed shapes below before calling
 * in here, so this file is plain DB logic and testable with vitest directly
 * against a throwaway database, no Nuxt boot required.
 */

export type CalorieBasis = 'device' | 'device_window' | 'estimated'
export type CalorieSource = 'device' | 'estimate'

export interface SyncSession {
  external_id: string
  type: string
  /** ISO 8601 with an explicit offset — see assertIsoDateTime. */
  start: string
  end: string
  active_kcal: number | null
  active_kcal_basis: 'device' | 'device_window'
  distance_km: number | null
  avg_heart_rate: number | null
}

export interface SyncDaily {
  date: string
  steps: number | null
  active_kcal: number | null
}

export interface SyncPayload {
  sessions: SyncSession[]
  deleted: string[]
  daily: SyncDaily[]
}

export interface SyncResult {
  imported: number
  updated: number
  deleted: number
  skipped: number
  basis: { device: number; device_window: number; estimated: number }
}

/**
 * The local calendar day a session belongs to, straight from its own
 * timestamp. `start` already carries the device's own offset (its ISO string
 * is written in local time, not shifted to UTC), so the date portion of the
 * string *is* the correct local day — no timezone conversion needed. This is
 * the one place server-side date derivation is correct rather than forbidden
 * (docs/schema-and-db.md's "today belongs to the user" rule): the device is
 * the best available witness to where the user actually was.
 */
export function localDateFromIso(iso: string): string {
  return iso.slice(0, 10)
}

/**
 * The three-step calorie cascade (docs/samsung-health-sync.md §2.1): the
 * session's own figure, else what the app computed by summing the window
 * (both arrive as `active_kcal`, distinguished by `active_kcal_basis`), else
 * MET x kg x hours from the mapped exercise.
 */
export function resolveCalories(
  session: Pick<SyncSession, 'active_kcal' | 'active_kcal_basis'>,
  met: number,
  weightKg: number,
  durationMin: number,
): { calories: number; deviceKcal: number | null; basis: CalorieBasis } {
  if (session.active_kcal != null) {
    const basis: CalorieBasis =
      session.active_kcal_basis === 'device_window' ? 'device_window' : 'device'
    return { calories: session.active_kcal, deviceKcal: session.active_kcal, basis }
  }

  return {
    calories: estimateCalories(met, weightKg, durationMin),
    deviceKcal: null,
    basis: 'estimated',
  }
}

/** Exercise id + moderate MET for a mapped activity, creating nothing. */
function findExercise(
  db: DatabaseSync,
  name: string,
): { id: number; met: number } | undefined {
  return db
    .prepare(
      `SELECT id, met FROM exercises WHERE name = ? AND owner_user_id IS NULL`,
    )
    .get(name) as { id: number; met: number } | undefined
}

function mostRecentWeightKg(db: DatabaseSync, userId: number): number {
  const recent = db
    .prepare(
      'SELECT weight_kg FROM weight_entries WHERE user_id = ? ORDER BY date DESC LIMIT 1',
    )
    .get(userId) as { weight_kg: number } | undefined
  return recent?.weight_kg ?? FALLBACK_WEIGHT_KG
}

/** Process one sync payload for one user: upsert sessions, apply deletions, record daily figures. */
export function processSync(db: DatabaseSync, userId: number, payload: SyncPayload): SyncResult {
  const result: SyncResult = {
    imported: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    basis: { device: 0, device_window: 0, estimated: 0 },
  }

  const weightKg = mostRecentWeightKg(db, userId)

  const isIgnored = db.prepare(
    'SELECT 1 FROM health_ignored WHERE user_id = ? AND external_id = ?',
  )
  const existing = db.prepare(
    'SELECT id FROM workout_entries WHERE user_id = ? AND external_id = ?',
  )
  const upsert = db.prepare(
    `INSERT INTO workout_entries
       (user_id, date, exercise_id, duration_min, calories, source, external_id,
        started_at, device_kcal, calorie_basis, distance_km)
     VALUES (?, ?, ?, ?, ?, 'health_connect', ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       date          = excluded.date,
       exercise_id   = excluded.exercise_id,
       duration_min  = excluded.duration_min,
       calories      = excluded.calories,
       started_at    = excluded.started_at,
       device_kcal   = excluded.device_kcal,
       calorie_basis = excluded.calorie_basis,
       distance_km   = excluded.distance_km`,
  )

  for (const session of payload.sessions) {
    if (isIgnored.get(userId, session.external_id)) {
      result.skipped++
      continue
    }

    const activityName = mapHealthConnectType(session.type)
    const exercise = findExercise(db, activityName)
    if (!exercise) {
      // The shared library hasn't been synced with this activity name (or
      // shared/healthConnect.ts points somewhere that no longer exists) —
      // skip rather than crash a whole payload over one bad session.
      result.skipped++
      continue
    }

    const durationMin = (Date.parse(session.end) - Date.parse(session.start)) / 60_000
    const { calories, deviceKcal, basis } = resolveCalories(
      session,
      exercise.met,
      weightKg,
      durationMin,
    )
    result.basis[basis]++

    const wasKnown = Boolean(existing.get(userId, session.external_id))

    upsert.run(
      userId,
      localDateFromIso(session.start),
      exercise.id,
      Math.round(durationMin),
      Math.round(calories),
      session.external_id,
      session.start,
      deviceKcal === null ? null : Math.round(deviceKcal),
      basis,
      session.distance_km,
    )

    if (wasKnown) result.updated++
    else result.imported++
  }

  // A device sync must never be able to touch a hand-logged workout — the
  // partial unique index only matches health_connect rows anyway (manual
  // rows never set external_id), but the explicit source filter is the
  // guarantee this makes to the rest of the app, not an accident of the index.
  const del = db.prepare(
    `DELETE FROM workout_entries
     WHERE user_id = ? AND external_id = ? AND source = 'health_connect'`,
  )
  for (const externalId of payload.deleted) {
    const info = del.run(userId, externalId)
    result.deleted += info.changes as number
  }

  if (payload.daily.length > 0) {
    const stepsType = ensureBiometricType(db, userId, 'Steps', 'steps')
    const activeKcalType = ensureBiometricType(db, userId, 'Active calories', 'kcal')
    const upsertDaily = db.prepare(
      `INSERT INTO biometric_entries (user_id, type_id, date, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, type_id, date) DO UPDATE SET value = excluded.value`,
    )
    for (const day of payload.daily) {
      if (day.steps != null) upsertDaily.run(userId, stepsType, day.date, day.steps)
      if (day.active_kcal != null) upsertDaily.run(userId, activeKcalType, day.date, day.active_kcal)
    }
  }

  return result
}

const SYNC_LOG_KEEP = 20

/**
 * Insert a sync-log row before the payload is processed, so a throw partway
 * through still leaves a record. Returns the row id to update with the
 * outcome once processing finishes (or fails) — see
 * server/api/health/sync.post.ts.
 */
export function insertSyncLog(
  db: DatabaseSync,
  userId: number,
  rawBody: unknown,
  sessionCount: number,
): number {
  const info = db
    .prepare(
      `INSERT INTO health_sync_log (user_id, payload, session_count, outcome)
       VALUES (?, ?, ?, 'pending')`,
    )
    .run(userId, JSON.stringify(rawBody), sessionCount)
  return Number(info.lastInsertRowid)
}

export function updateSyncLogOutcome(db: DatabaseSync, logId: number, outcome: string): void {
  db.prepare('UPDATE health_sync_log SET outcome = ? WHERE id = ?').run(outcome, logId)
}

/** Keep only the most recent SYNC_LOG_KEEP rows per user — see the table comment. */
export function trimSyncLog(db: DatabaseSync, userId: number): void {
  db.prepare(
    `DELETE FROM health_sync_log
     WHERE user_id = ? AND id NOT IN (
       SELECT id FROM health_sync_log WHERE user_id = ? ORDER BY id DESC LIMIT ?
     )`,
  ).run(userId, userId, SYNC_LOG_KEEP)
}

/** Find or create the per-user biometric type a daily figure upserts into. */
function ensureBiometricType(db: DatabaseSync, userId: number, name: string, unit: string): number {
  const existing = db
    .prepare('SELECT id FROM biometric_types WHERE user_id = ? AND name = ?')
    .get(userId, name) as { id: number } | undefined
  if (existing) return existing.id

  const info = db
    .prepare('INSERT INTO biometric_types (user_id, name, unit) VALUES (?, ?, ?)')
    .run(userId, name, unit)
  return Number(info.lastInsertRowid)
}

/**
 * Apply user_goals.workout_calorie_source to existing history.
 *
 * Flipping to 'device' restores each row's raw `device_kcal` where the
 * cascade actually had one; a row the cascade already fell back to
 * 'estimated' for has no device figure to switch to, so it is left alone.
 * Flipping to 'estimate' recomputes every device row from MET x kg x hours,
 * using the most recent known weight — a device row doesn't carry the body
 * weight at the time of the workout, only its duration and mapped exercise,
 * the same limitation server/api/workouts/index.post.ts already has for a
 * manual entry with no weight logged that day.
 *
 * Either direction touches only source = 'health_connect' rows; a
 * hand-logged workout is never recomputed.
 */
export function recomputeDeviceCalories(
  db: DatabaseSync,
  userId: number,
  calorieSource: CalorieSource,
): void {
  if (calorieSource === 'device') {
    db.prepare(
      `UPDATE workout_entries
       SET calories = device_kcal
       WHERE user_id = ? AND source = 'health_connect' AND device_kcal IS NOT NULL`,
    ).run(userId)
    return
  }

  const weightKg = mostRecentWeightKg(db, userId)
  const rows = db
    .prepare(
      `SELECT w.id, w.duration_min, e.met
       FROM workout_entries w
       JOIN exercises e ON e.id = w.exercise_id
       WHERE w.user_id = ? AND w.source = 'health_connect'
         AND w.duration_min IS NOT NULL AND e.met IS NOT NULL`,
    )
    .all(userId) as { id: number; duration_min: number; met: number }[]

  const update = db.prepare('UPDATE workout_entries SET calories = ? WHERE id = ?')
  for (const row of rows) {
    update.run(Math.round(estimateCalories(row.met, weightKg, row.duration_min)), row.id)
  }
}

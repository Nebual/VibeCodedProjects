/**
 * Ingest a Health Connect sync payload from a paired phone.
 *
 * Behind requireDevice(), not requireUser() — the phone authenticates with a
 * device token, not a browser session. See docs/samsung-health-sync.md §3–§5.
 *
 * The payload is logged before it's processed (insertSyncLog, below) so a
 * throw partway through still leaves the evidence behind — Samsung Health is
 * reported to stop syncing silently after some app updates, and this is how
 * that gets noticed rather than discovered as a gap in Trends weeks later.
 */
import { requireDevice } from '../../utils/deviceAuth'
import {
  insertSyncLog,
  processSync,
  trimSyncLog,
  updateSyncLogOutcome,
  type SyncDaily,
  type SyncPayload,
  type SyncSession,
} from '../../utils/healthSync'

function assertArray(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: `${field} must be an array` })
  }
  return value
}

function parseSession(raw: unknown, index: number): SyncSession {
  const item = raw as Record<string, unknown>
  const field = (name: string) => `sessions[${index}].${name}`

  return {
    external_id: assertText(item.external_id, field('external_id'), 200),
    type: assertText(item.type, field('type'), 100),
    start: assertIsoDateTime(item.start, field('start')),
    end: assertIsoDateTime(item.end, field('end')),
    // Legitimately absent — that's the whole reason for the calorie cascade
    // (docs/samsung-health-sync.md §2.1), so this must stay optional, not
    // required, in validation.
    active_kcal: optionalNumber(item.active_kcal, field('active_kcal'), { min: 0, max: 20000 }),
    active_kcal_basis: item.active_kcal_basis === 'device_window' ? 'device_window' : 'device',
    distance_km: optionalNumber(item.distance_km, field('distance_km'), { min: 0, max: 1000 }),
    avg_heart_rate: optionalNumber(item.avg_heart_rate, field('avg_heart_rate'), {
      min: 0,
      max: 300,
    }),
  }
}

function parseDaily(raw: unknown, index: number): SyncDaily {
  const item = raw as Record<string, unknown>
  const field = (name: string) => `daily[${index}].${name}`

  return {
    date: assertDate(item.date, field('date')),
    steps: optionalNumber(item.steps, field('steps'), { min: 0, max: 200_000 }),
    active_kcal: optionalNumber(item.active_kcal, field('active_kcal'), { min: 0, max: 20000 }),
  }
}

function parsePayload(body: Record<string, unknown>): SyncPayload {
  const sessions = assertArray(body.sessions, 'sessions').map((s, i) => parseSession(s, i))
  const deleted = assertArray(body.deleted, 'deleted').map((id, i) =>
    assertText(id, `deleted[${i}]`, 200),
  )
  const daily = assertArray(body.daily, 'daily').map((d, i) => parseDaily(d, i))
  return { sessions, deleted, daily }
}

export default defineEventHandler(async (event) => {
  const { device, user } = await requireDevice(event)
  const rawBody = await readBody<Record<string, unknown>>(event)

  const db = useDb()
  const sessionCount = Array.isArray(rawBody.sessions) ? rawBody.sessions.length : 0
  const logId = insertSyncLog(db, user.id, rawBody, sessionCount)

  try {
    const payload = parsePayload(rawBody)
    const result = processSync(db, user.id, payload)

    updateSyncLogOutcome(db, logId, 'ok')
    trimSyncLog(db, user.id)
    db.prepare("UPDATE device_tokens SET last_sync_at = datetime('now') WHERE id = ?").run(
      device.id,
    )

    return result
  } catch (err) {
    updateSyncLogOutcome(db, logId, err instanceof Error ? err.message : 'error')
    throw err
  }
})

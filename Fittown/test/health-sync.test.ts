import { describe, expect, it } from 'vitest'
import {
  localDateFromIso,
  resolveCalories,
  type SyncSession,
} from '../server/utils/healthSync'
import { FALLBACK_ACTIVITY_NAME, mapHealthConnectType } from '#shared/healthConnect'

/**
 * The pure pieces of device sync: the calorie cascade
 * (docs/samsung-health-sync.md §2.1), local-date derivation, and the Health
 * Connect exercise mapping. The DB-backed behaviour (idempotency, deletion
 * guard, daily upserts) lives in health-sync-db.test.ts.
 */

describe('localDateFromIso', () => {
  it('reads the date straight off the string, not through UTC', () => {
    // 23:30 in Vancouver — converting through UTC (+7h) would land on the
    // 30th. The date must come from the offset already in the string.
    expect(localDateFromIso('2026-08-29T23:30:00-07:00')).toBe('2026-08-29')
  })

  it('handles a UTC (Z) timestamp the same way', () => {
    expect(localDateFromIso('2026-08-29T07:00:00Z')).toBe('2026-08-29')
  })
})

describe('resolveCalories', () => {
  const base = { active_kcal: null, active_kcal_basis: 'device' as const }

  it('uses the session figure as basis "device" when active_kcal_basis says so', () => {
    const result = resolveCalories(
      { active_kcal: 412, active_kcal_basis: 'device' },
      10,
      80,
      36,
    )
    expect(result).toEqual({ calories: 412, deviceKcal: 412, basis: 'device' })
  })

  it('uses the same figure as basis "device_window" when the app labels it that way', () => {
    const result = resolveCalories(
      { active_kcal: 280, active_kcal_basis: 'device_window' },
      10,
      80,
      36,
    )
    expect(result).toEqual({ calories: 280, deviceKcal: 280, basis: 'device_window' })
  })

  it('falls back to MET x kg x hours when no device figure is present at all', () => {
    const result = resolveCalories({ ...base, active_kcal: null }, 10, 80, 30)
    // 10 MET x 80 kg x 0.5 h = 400
    expect(result.calories).toBeCloseTo(400)
    expect(result.deviceKcal).toBeNull()
    expect(result.basis).toBe('estimated')
  })

  it('treats zero as a real device figure, not "missing"', () => {
    const result = resolveCalories({ active_kcal: 0, active_kcal_basis: 'device' }, 10, 80, 30)
    expect(result).toEqual({ calories: 0, deviceKcal: 0, basis: 'device' })
  })

  it('never uses a session field beyond active_kcal/active_kcal_basis', () => {
    const session: Pick<SyncSession, 'active_kcal' | 'active_kcal_basis'> = {
      active_kcal: 200,
      active_kcal_basis: 'device',
    }
    expect(resolveCalories(session, 10, 80, 30).calories).toBe(200)
  })
})

describe('mapHealthConnectType', () => {
  it('maps a known Health Connect type onto the matching Fittown activity', () => {
    expect(mapHealthConnectType('RUNNING')).toBe('Running')
    expect(mapHealthConnectType('BIKING')).toBe('Cycling')
    expect(mapHealthConnectType('SWIMMING_POOL')).toBe('Swimming (laps)')
  })

  it('falls back to the generic activity for an unrecognised type', () => {
    expect(mapHealthConnectType('SOME_FUTURE_TYPE')).toBe(FALLBACK_ACTIVITY_NAME)
    expect(FALLBACK_ACTIVITY_NAME).toBe('Tracked workout')
  })
})

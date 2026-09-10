import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The trends rollup. Covered here only where it decides what leaves the
 * server: the range-independent latest weight, which the calorie chart needs
 * to estimate maintenance and which a friend must never be handed.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-summary-test-'))
  dbPath = join(dir, 'test.db')
  process.env.FITTOWN_DB_PATH = dbPath
  vi.resetModules()
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

const summary = () => import('../server/utils/summary')

function seedUser(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')").run()
}

function weighIn(db: DatabaseSync, date: string, kg: number) {
  db.prepare('INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (1, ?, ?)').run(date, kg)
}

describe('summarise', () => {
  it('reports the latest weigh-in even when it predates the range', async () => {
    const db = await boot()
    seedUser(db)
    weighIn(db, '2026-07-02', 74.1)
    const { summarise } = await summary()

    const result = summarise(db, 1, '2026-08-01', '2026-08-07', 'full')

    expect(result.weights).toEqual([]) // nothing inside the range itself
    expect(result.latest_weight_kg).toBe(74.1)
  })

  it('takes the most recent weigh-in, not the first or the heaviest', async () => {
    const db = await boot()
    seedUser(db)
    weighIn(db, '2026-08-01', 74.1)
    weighIn(db, '2026-08-05', 72.4)
    weighIn(db, '2026-08-03', 75.9)
    const { summarise } = await summary()

    expect(summarise(db, 1, '2026-08-01', '2026-08-07', 'full').latest_weight_kg).toBe(72.4)
  })

  it('is null for a user who has never logged a weight', async () => {
    const db = await boot()
    seedUser(db)
    const { summarise } = await summary()

    expect(summarise(db, 1, '2026-08-01', '2026-08-07', 'full').latest_weight_kg).toBe(null)
  })

  it('withholds it from the chart scope a friend reads', async () => {
    // Body metrics are stripped from a friend's goals, so the figure would be
    // useless to them — and `share_weight` is meant to be able to switch every
    // weight off, including this one.
    const db = await boot()
    seedUser(db)
    weighIn(db, '2026-08-05', 72.4)
    const { summarise } = await summary()

    expect(summarise(db, 1, '2026-08-01', '2026-08-07', 'chart').latest_weight_kg).toBe(null)
  })
})

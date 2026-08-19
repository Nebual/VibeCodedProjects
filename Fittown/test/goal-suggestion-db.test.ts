import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The database side of the "lower today's goal?" nudge: pulling a week of
 * daily kcal totals, and remembering the day's accept/dismiss choice.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-goal-suggestion-test-'))
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

const goalSuggestion = () => import('../server/utils/goalSuggestion')

function seedUser(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')").run()
}

function addFood(db: DatabaseSync, name: string, kcal: number | null) {
  return Number(
    db
      .prepare("INSERT INTO foods (source, name, kcal) VALUES ('off', ?, ?)")
      .run(name, kcal).lastInsertRowid,
  )
}

function log(db: DatabaseSync, date: string, foodId: number, grams: number) {
  db.prepare(
    "INSERT INTO diary_entries (user_id, date, meal, food_id, grams) VALUES (1, ?, 'snack', ?, ?)",
  ).run(date, foodId, grams)
}

describe('weeklyDailyKcals', () => {
  it('totals each of the 7 days before the given date, oldest first', async () => {
    const db = await boot()
    seedUser(db)
    const { weeklyDailyKcals } = await goalSuggestion()

    const food = addFood(db, 'Chicken', 200) // 200 kcal/100g
    log(db, '2026-08-11', food, 1000) // 2000 kcal, 7 days before the 18th
    log(db, '2026-08-17', food, 500) // 1000 kcal, the day before

    expect(weeklyDailyKcals(db, 1, '2026-08-18')).toEqual([
      2000, 0, 0, 0, 0, 0, 1000,
    ])
  })

  it('does not count the viewed date itself', async () => {
    const db = await boot()
    seedUser(db)
    const { weeklyDailyKcals } = await goalSuggestion()

    const food = addFood(db, 'Chicken', 200)
    log(db, '2026-08-18', food, 1000) // logged on the viewed day, not the week before it

    expect(weeklyDailyKcals(db, 1, '2026-08-18')).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('skips foods with no kcal figure rather than crashing on null', async () => {
    const db = await boot()
    seedUser(db)
    const { weeklyDailyKcals } = await goalSuggestion()

    const food = addFood(db, 'Mystery seasoning', null)
    log(db, '2026-08-17', food, 5)

    expect(weeklyDailyKcals(db, 1, '2026-08-18')).toEqual([0, 0, 0, 0, 0, 0, 0])
  })
})

describe('goal adjustments', () => {
  it('has no adjustment for a day that was never answered', async () => {
    const db = await boot()
    seedUser(db)
    const { getGoalAdjustment } = await goalSuggestion()
    expect(getGoalAdjustment(db, 1, '2026-08-18')).toBeNull()
  })

  it('remembers accept and dismiss per day', async () => {
    const db = await boot()
    seedUser(db)
    const { getGoalAdjustment, setGoalAdjustment } = await goalSuggestion()

    setGoalAdjustment(db, 1, '2026-08-18', 'accepted')
    expect(getGoalAdjustment(db, 1, '2026-08-18')).toBe('accepted')

    setGoalAdjustment(db, 1, '2026-08-19', 'dismissed')
    expect(getGoalAdjustment(db, 1, '2026-08-19')).toBe('dismissed')
    // Yesterday's answer is untouched by today's.
    expect(getGoalAdjustment(db, 1, '2026-08-18')).toBe('accepted')
  })

  it('lets a later answer replace an earlier one for the same day', async () => {
    const db = await boot()
    seedUser(db)
    const { getGoalAdjustment, setGoalAdjustment } = await goalSuggestion()

    setGoalAdjustment(db, 1, '2026-08-18', 'dismissed')
    setGoalAdjustment(db, 1, '2026-08-18', 'accepted')
    expect(getGoalAdjustment(db, 1, '2026-08-18')).toBe('accepted')
  })
})

import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recentExercises } from '../server/utils/exercises'

/**
 * The "recently used" list behind the quick-access row on the fitness page,
 * against a real database. Ordering, de-duplication and user scoping are the
 * kind of thing that looks right in a query and isn't.
 */

let dir: string
let db: DatabaseSync

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-recent-'))
  process.env.FITTOWN_DB_PATH = join(dir, 'test.db')
  vi.resetModules()
  const { useDb } = await import('../server/utils/db')
  db = useDb()

  db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@b.c', 'A')").run()
  db.prepare("INSERT INTO users (id, email, name) VALUES (2, 'x@y.z', 'X')").run()
})

afterEach(() => {
  delete process.env.FITTOWN_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

const idOf = (name: string) =>
  (db.prepare('SELECT id FROM exercises WHERE name = ? AND owner_user_id IS NULL').get(name) as {
    id: number
  }).id

/** Log a workout. `date` defaults to a fixed day so ordering can't lean on it. */
function log(userId: number, exercise: string, date = '2026-08-01') {
  db.prepare(
    `INSERT INTO workout_entries (user_id, date, exercise_id, duration_min, calories)
     VALUES (?, ?, ?, 30, 200)`,
  ).run(userId, date, idOf(exercise))
}

const names = (rows: Record<string, unknown>[]) => rows.map((r) => r.name)

describe('recentExercises', () => {
  it('returns nothing for someone who has never logged a workout', () => {
    expect(recentExercises(db, 1)).toEqual([])
  })

  it('puts the most recently logged activity first', () => {
    log(1, 'Running')
    log(1, 'Vacuuming')
    log(1, 'Yoga')
    expect(names(recentExercises(db, 1))).toEqual(['Yoga', 'Vacuuming', 'Running'])
  })

  it('lists each activity once, however often it was logged', () => {
    log(1, 'Running')
    log(1, 'Running')
    log(1, 'Yoga')
    log(1, 'Running')
    const result = names(recentExercises(db, 1))
    expect(result).toEqual(['Running', 'Yoga'])
    expect(result.filter((n) => n === 'Running')).toHaveLength(1)
  })

  it('re-logging an old activity moves it back to the front', () => {
    log(1, 'Running')
    log(1, 'Yoga')
    expect(names(recentExercises(db, 1))[0]).toBe('Yoga')
    log(1, 'Running')
    expect(names(recentExercises(db, 1))[0]).toBe('Running')
  })

  it('orders by when it was logged, not by the day it happened', () => {
    // Back-dating last week's hike is the most recent thing you did in the
    // app, even though the workout itself is older than this morning's run.
    log(1, 'Running', '2026-08-10')
    log(1, 'Hiking', '2026-08-03')
    expect(names(recentExercises(db, 1))[0]).toBe('Hiking')
  })

  it('caps the list at the requested length', () => {
    const activities = [
      'Running', 'Yoga', 'Vacuuming', 'Cycling', 'Swimming (laps)',
      'Pilates', 'Boxing', 'Tennis', 'Mopping', 'Hiking', 'Gardening', 'Rugby',
    ]
    for (const activity of activities) log(1, activity)

    expect(recentExercises(db, 1)).toHaveLength(10)
    expect(recentExercises(db, 1, 3)).toHaveLength(3)
    // The ten kept are the ten most recent, i.e. the tail of the input.
    expect(names(recentExercises(db, 1, 3))).toEqual(['Rugby', 'Gardening', 'Hiking'])
  })

  it('never leaks another household member’s activities', () => {
    log(2, 'Rugby')
    log(1, 'Yoga')
    expect(names(recentExercises(db, 1))).toEqual(['Yoga'])
    expect(names(recentExercises(db, 2))).toEqual(['Rugby'])
  })

  it('returns the same shape as the browse and search lists', () => {
    log(1, 'Running')
    const [row] = recentExercises(db, 1)
    // The picker renders recents and search results with one component.
    for (const key of [
      'id', 'name', 'category', 'met', 'met_light', 'met_hard',
      'tracks_sets', 'tracks_distance', 'hint', 'owner_user_id', 'categories',
    ]) {
      expect(row, `missing ${key}`).toHaveProperty(key)
    }
    expect(row!.categories).toEqual(expect.arrayContaining(['cardio']))
    // The ordering column is an implementation detail, not part of the shape.
    expect(row).not.toHaveProperty('last_logged_id')
  })

  it('includes a user’s own custom activities', () => {
    db.prepare(
      "INSERT INTO exercises (id, name, category, met, owner_user_id) VALUES (900, 'Trampolining', 'cardio', 6, 1)",
    ).run()
    db.prepare(
      `INSERT INTO workout_entries (user_id, date, exercise_id, duration_min, calories)
       VALUES (1, '2026-08-01', 900, 20, 100)`,
    ).run()

    const [row] = recentExercises(db, 1)
    expect(row!.name).toBe('Trampolining')
    // No category rows for a custom activity, and that must not break it.
    expect(row!.categories).toEqual([])
  })
})

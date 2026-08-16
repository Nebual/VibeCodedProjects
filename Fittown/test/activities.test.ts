import { describe, expect, it } from 'vitest'
import {
  ACTIVITIES,
  ACTIVITY_CATEGORIES,
  EFFORT_KEYS,
  EFFORT_LEVELS,
  activityCategory,
  effortLevel,
  estimateCalories,
  hasEffortLevels,
  metColumns,
  metFor,
} from '#shared/activities'

const CATEGORY_KEYS = ACTIVITY_CATEGORIES.map((c) => c.key)

describe('effort levels', () => {
  it('offers exactly the three the UI describes', () => {
    expect(EFFORT_KEYS).toEqual(['light', 'moderate', 'hard'])
  })

  it('describes each level by breathing, not by pace', () => {
    // The whole point of the wording: it transfers across walking, mopping
    // and squash, where "moderate pace" does not.
    for (const level of EFFORT_LEVELS) {
      expect(level.description).toMatch(/breath|heart/i)
      expect(level.description.length).toBeGreaterThan(40)
    }
  })

  it('resolves a known level and rejects an unknown one', () => {
    expect(effortLevel('hard')?.label).toBe('Hard')
    expect(effortLevel('extreme')).toBeNull()
    expect(effortLevel(null)).toBeNull()
  })
})

describe('activity library', () => {
  it('has no duplicate names — name is the database key', () => {
    // syncExerciseLibrary() upserts on name, so a duplicate here would make
    // one activity silently overwrite another on every boot.
    const names = ACTIVITIES.map((a) => a.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('files every activity under at least one real category', () => {
    for (const activity of ACTIVITIES) {
      expect(activity.categories.length).toBeGreaterThan(0)
      for (const category of activity.categories) {
        expect(CATEGORY_KEYS).toContain(category)
      }
      // A repeated category would create a duplicate join row.
      expect(new Set(activity.categories).size).toBe(activity.categories.length)
    }
  })

  it('leaves no category empty, so the grid never opens onto nothing', () => {
    for (const key of CATEGORY_KEYS) {
      const count = ACTIVITIES.filter((a) => a.categories.includes(key)).length
      expect(count, `category "${key}" has no activities`).toBeGreaterThan(0)
    }
  })

  it('files genuinely cross-cutting activities under several categories', () => {
    const categoriesOf = (name: string) =>
      ACTIVITIES.find((a) => a.name === name)!.categories
    expect(categoriesOf('Cycling')).toEqual(expect.arrayContaining(['cardio', 'outdoor']))
    expect(categoriesOf('Gardening')).toEqual(expect.arrayContaining(['household', 'outdoor']))
    expect(categoriesOf('Rowing machine')).toEqual(
      expect.arrayContaining(['cardio', 'gym', 'strength']),
    )
  })

  it('keeps every MET inside a physiologically possible range', () => {
    // Resting is 1 MET; the highest sustained human efforts are around 20.
    for (const activity of ACTIVITIES) {
      const values = hasEffortLevels(activity.met)
        ? Object.values(activity.met)
        : [activity.met]
      for (const met of values) {
        expect(met, `${activity.name} has an implausible MET`).toBeGreaterThanOrEqual(1)
        expect(met, `${activity.name} has an implausible MET`).toBeLessThanOrEqual(20)
      }
    }
  })

  it('orders effort levels light < moderate < hard', () => {
    // A picker where "hard" burns less than "light" is worse than no picker.
    for (const activity of ACTIVITIES) {
      if (!hasEffortLevels(activity.met)) continue
      const { light, moderate, hard } = activity.met
      expect(light, `${activity.name}`).toBeLessThan(moderate)
      expect(moderate, `${activity.name}`).toBeLessThan(hard)
    }
  })

  it('only tracks fields that make sense for the activity', () => {
    for (const activity of ACTIVITIES) {
      for (const field of activity.tracks ?? []) {
        expect(['distance', 'sets']).toContain(field)
      }
    }
    const find = (name: string) => ACTIVITIES.find((a) => a.name === name)!
    expect(find('Running').tracks).toContain('distance')
    expect(find('Weight training').tracks).toContain('sets')
    expect(find('Washing dishes').tracks).toBeUndefined()
  })

  it('carries the compendium values that were checked against the source', () => {
    const met = (name: string) => ACTIVITIES.find((a) => a.name === name)!.met
    // Spot checks against pacompendium.com, one per major heading.
    expect(met('Vacuuming')).toBe(3.0)
    expect(met('Washing dishes')).toBe(2.0)
    expect(met('Scrubbing floors or bathroom')).toEqual({ light: 2.0, moderate: 3.5, hard: 6.5 })
    expect(met('Skiing (downhill)')).toEqual({ light: 4.3, moderate: 6.3, hard: 8.0 })
    expect(met('Farm work')).toEqual({ light: 2.0, moderate: 4.8, hard: 7.8 })
    expect(met('Desk work')).toBe(1.3)
    expect(met('Ultimate frisbee')).toBe(8.0)
  })

  it('gives a hint wherever effort maps onto a measurable pace', () => {
    const running = ACTIVITIES.find((a) => a.name === 'Running')!
    expect(running.hint).toMatch(/km\/h/)
  })
})

describe('categories', () => {
  it('covers the eight the user browses', () => {
    expect(CATEGORY_KEYS).toEqual([
      'cardio', 'gym', 'strength', 'mobility',
      'sports', 'outdoor', 'household', 'occupational',
    ])
  })

  it('gives every category a label, icon and blurb', () => {
    for (const category of ACTIVITY_CATEGORIES) {
      expect(category.label).toBeTruthy()
      expect(category.icon).toBeTruthy()
      expect(category.blurb).toBeTruthy()
    }
  })

  it('resolves a known category and rejects an unknown one', () => {
    expect(activityCategory('cardio')?.label).toBe('Cardio')
    expect(activityCategory('knitting')).toBeNull()
  })
})

describe('MET selection', () => {
  const withEffort = { light: 2.0, moderate: 3.5, hard: 6.5 }

  it('picks the column matching the chosen effort', () => {
    expect(metFor(withEffort, 'light')).toBe(2.0)
    expect(metFor(withEffort, 'moderate')).toBe(3.5)
    expect(metFor(withEffort, 'hard')).toBe(6.5)
  })

  it('falls back to moderate when no effort was recorded', () => {
    expect(metFor(withEffort, null)).toBe(3.5)
    expect(metFor(withEffort)).toBe(3.5)
  })

  it('ignores effort entirely for a flat activity', () => {
    expect(metFor(2.0, 'hard')).toBe(2.0)
    expect(metFor(2.0, 'light')).toBe(2.0)
  })

  it('maps to the database columns, nulling the ones that do not apply', () => {
    expect(metColumns(withEffort)).toEqual({ met: 3.5, met_light: 2.0, met_hard: 6.5 })
    // Null, not a repeat of the flat value: null is what tells the UI to
    // hide the effort picker.
    expect(metColumns(2.0)).toEqual({ met: 2.0, met_light: null, met_hard: null })
  })

  it('detects which shape a MET spec is', () => {
    expect(hasEffortLevels(withEffort)).toBe(true)
    expect(hasEffortLevels(2.0)).toBe(false)
  })
})

describe('calorie estimation', () => {
  it('is MET x kg x hours', () => {
    expect(estimateCalories(3.0, 72.5, 60)).toBeCloseTo(217.5, 6)
  })

  it('reproduces the figures shown in the effort picker', () => {
    // Running, 30 minutes, 72.5 kg — the numbers on screen in the e2e run.
    expect(Math.round(estimateCalories(6.5, 72.5, 30))).toBe(236)
    expect(Math.round(estimateCalories(9.3, 72.5, 30))).toBe(337)
    expect(Math.round(estimateCalories(12.0, 72.5, 30))).toBe(435)
  })

  it('scales linearly with duration and weight', () => {
    expect(estimateCalories(8, 70, 60)).toBeCloseTo(estimateCalories(8, 70, 30) * 2, 6)
    expect(estimateCalories(8, 140, 30)).toBeCloseTo(estimateCalories(8, 70, 30) * 2, 6)
  })

  it('returns nothing for a zero-length session', () => {
    expect(estimateCalories(8, 70, 0)).toBe(0)
  })
})

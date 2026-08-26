import { describe, expect, it } from 'vitest'
import {
  dayOfMonthOf,
  describeSchedule,
  normalizeSchedule,
  occursOn,
  weekdayOf,
  type ReminderScheduleRule,
} from '#shared/reminders'

/**
 * Reminder recurrence maths. The subtle case is the versioned history: a
 * rule change must affect only days on/after its effective_from, which is
 * what keeps "moved Garbage from Thursdays to Fridays" from rewriting the
 * past. These tests pin that down.
 */

const rule = (overrides: Partial<ReminderScheduleRule>): ReminderScheduleRule => ({
  effective_from: '2026-01-01',
  freq: 'daily',
  interval: 1,
  byweekday: [],
  day_of_month: null,
  ...overrides,
})

describe('weekdayOf / dayOfMonthOf', () => {
  it('knows its weekdays', () => {
    // 2026-08-26 is a Wednesday.
    expect(weekdayOf('2026-08-26')).toBe(3)
    expect(weekdayOf('2026-08-28')).toBe(5)
  })

  it('extracts day of month', () => {
    expect(dayOfMonthOf('2026-08-05')).toBe(5)
    expect(dayOfMonthOf('2026-08-31')).toBe(31)
  })
})

describe('occursOn', () => {
  it('daily occurs every day from effective_from', () => {
    const r = rule({ freq: 'daily' })
    expect(occursOn(r, '2026-01-01')).toBe(true)
    expect(occursOn(r, '2026-05-17')).toBe(true)
  })

  it('daily does not occur before effective_from', () => {
    const r = rule({ freq: 'daily', effective_from: '2026-03-10' })
    expect(occursOn(r, '2026-03-09')).toBe(false)
    expect(occursOn(r, '2026-03-10')).toBe(true)
  })

  it('weekly on one weekday', () => {
    // Anchored to a Friday (2026-01-02).
    const r = rule({ freq: 'weekly', interval: 1, byweekday: [5], effective_from: '2026-01-02' })
    expect(occursOn(r, '2026-01-02')).toBe(true)
    expect(occursOn(r, '2026-01-09')).toBe(true)
    expect(occursOn(r, '2026-01-10')).toBe(false)
  })

  it('every N weeks anchors to effective_from, not the calendar', () => {
    // Every other Friday from Jan 2 → Jan 2, 16, 30… not the "other" Fridays.
    const r = rule({ freq: 'weekly', interval: 2, byweekday: [5], effective_from: '2026-01-02' })
    expect(occursOn(r, '2026-01-02')).toBe(true)
    expect(occursOn(r, '2026-01-09')).toBe(false)
    expect(occursOn(r, '2026-01-16')).toBe(true)
    expect(occursOn(r, '2026-01-23')).toBe(false)
    expect(occursOn(r, '2026-01-30')).toBe(true)
  })

  it('weekly can hit multiple weekdays in the same week', () => {
    // Monday & Friday.
    const r = rule({ freq: 'weekly', interval: 1, byweekday: [1, 5], effective_from: '2026-01-05' })
    expect(occursOn(r, '2026-01-05')).toBe(true) // Mon
    expect(occursOn(r, '2026-01-07')).toBe(false) // Wed
    expect(occursOn(r, '2026-01-09')).toBe(true) // Fri
  })

  it('monthly fires on its day of month', () => {
    const r = rule({ freq: 'monthly', day_of_month: 1, effective_from: '2026-01-01' })
    expect(occursOn(r, '2026-01-01')).toBe(true)
    expect(occursOn(r, '2026-02-01')).toBe(true)
    expect(occursOn(r, '2026-02-02')).toBe(false)
  })

  it('monthly skips months without that day rather than clamping', () => {
    const r = rule({ freq: 'monthly', day_of_month: 31, effective_from: '2026-01-31' })
    expect(occursOn(r, '2026-01-31')).toBe(true)
    expect(occursOn(r, '2026-04-30')).toBe(false) // April has no 31st
    expect(occursOn(r, '2026-05-31')).toBe(true)
  })
})

describe('describeSchedule', () => {
  it('labels weekly single/multi-day and intervals', () => {
    expect(describeSchedule(rule({ freq: 'weekly', interval: 1, byweekday: [5] })))
      .toBe('Weekly on Fri')
    expect(describeSchedule(rule({ freq: 'weekly', interval: 1, byweekday: [1, 5] })))
      .toBe('Weekly on Mon & Fri')
    expect(describeSchedule(rule({ freq: 'weekly', interval: 2, byweekday: [4] })))
      .toBe('Every 2 weeks on Thu')
    expect(describeSchedule(rule({ freq: 'weekly', interval: 5, byweekday: [4] })))
      .toBe('Every 5 weeks on Thu')
  })

  it('labels monthly with an ordinal', () => {
    expect(describeSchedule(rule({ freq: 'monthly', day_of_month: 1 })))
      .toBe('Monthly on the 1st')
    expect(describeSchedule(rule({ freq: 'monthly', day_of_month: 22 })))
      .toBe('Monthly on the 22nd')
    expect(describeSchedule(rule({ freq: 'monthly', day_of_month: 13 })))
      .toBe('Monthly on the 13th')
    expect(describeSchedule(rule({ freq: 'monthly', day_of_month: 11 })))
      .toBe('Monthly on the 11th')
  })

  it('daily needs no label', () => {
    expect(describeSchedule(rule({ freq: 'daily' }))).toBeNull()
  })
})

describe('normalizeSchedule (API input validation)', () => {
  it('accepts each frequency with its fields', () => {
    expect(normalizeSchedule({ freq: 'daily' })).toEqual({
      ok: true,
      rule: { freq: 'daily', interval: 1, byweekday: [], day_of_month: null },
    })
    expect(normalizeSchedule({ freq: 'weekly', interval: 2, byweekday: [4] })).toMatchObject({
      ok: true,
    })
    expect(normalizeSchedule({ freq: 'monthly', day_of_month: 15 })).toMatchObject({ ok: true })
  })

  it('rejects bad frequencies and out-of-range fields', () => {
    expect(normalizeSchedule({ freq: 'yearly' })).toMatchObject({ ok: false })
    expect(normalizeSchedule({ freq: 'weekly', interval: 0, byweekday: [1] }))
      .toMatchObject({ ok: false })
    expect(normalizeSchedule({ freq: 'weekly', interval: 53, byweekday: [1] }))
      .toMatchObject({ ok: false })
    expect(normalizeSchedule({ freq: 'weekly', interval: 1, byweekday: [] }))
      .toMatchObject({ ok: false })
    expect(normalizeSchedule({ freq: 'weekly', interval: 1, byweekday: [7] }))
      .toMatchObject({ ok: false })
    expect(normalizeSchedule({ freq: 'monthly', day_of_month: 0 })).toMatchObject({ ok: false })
    expect(normalizeSchedule({ freq: 'monthly', day_of_month: 32 })).toMatchObject({ ok: false })
  })

  it('dedupes and sorts weekdays', () => {
    const out = normalizeSchedule({ freq: 'weekly', interval: 1, byweekday: [5, 1, 5] })
    expect(out.ok && out.rule.byweekday).toEqual([1, 5])
  })
})

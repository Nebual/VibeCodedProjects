import { describe, expect, it } from 'vitest'
import { addDays, diaryDayIn, hourIn, humanDate } from '~/utils/dates'

/**
 * The diary's notion of "today" and how it names days. These are the two
 * pieces that make a 2am bowl of cereal land on yesterday's page, and that tell
 * the day switcher "Yesterday (Wed)" instead of a plain "Yesterday".
 */

describe('diaryDayIn', () => {
  // A fixed instant where it is just past midnight in the given zone, so the
  // result doesn't depend on when the test happens to run. 'America/New_York'
  // on 2021-01-01 00:30 = '2021-01-01 00:30' there.
  const now = new Date('2021-01-01T05:30:00Z') // 00:30 in New York (EST)

  it('is yesterday between midnight and 3am', () => {
    expect(diaryDayIn('America/New_York', now)).toBe('2020-12-31')
  })

  it('is today at 3am and after', () => {
    // 08:00 UTC = 03:00 EST — the boundary is exclusive.
    expect(diaryDayIn('America/New_York', new Date('2021-01-01T08:00:00Z'))).toBe('2021-01-01')
    expect(diaryDayIn('America/New_York', new Date('2021-01-01T20:00:00Z'))).toBe('2021-01-01')
  })

  it('resolves the timezone not the host, so a UTC host and a Toronto phone agree', () => {
    // 23:30 UTC is 18:30 Toronto — same day, mid-evening, not a shift.
    const evening = new Date('2021-01-01T23:30:00Z')
    expect(hourIn('America/Toronto', evening)).toBe(18)
    expect(diaryDayIn('America/Toronto', evening)).toBe('2021-01-01')
  })
})

describe('humanDate', () => {
  it('names Today/Yesterday/Tomorrow with the weekday', () => {
    const today = '2026-08-20'
    expect(humanDate('2026-08-20', today)).toBe('Today (Thu)')
    expect(humanDate('2026-08-19', today)).toBe('Yesterday (Wed)')
    expect(humanDate('2026-08-21', today)).toBe('Tomorrow (Fri)')
  })

  it('keeps the full weekday for older and newer days', () => {
    expect(humanDate(addDays('2026-08-20', -2), '2026-08-20')).toMatch(/^Tue/)
    expect(humanDate(addDays('2026-08-20', 2), '2026-08-20')).toMatch(/^Sat/)
  })
})
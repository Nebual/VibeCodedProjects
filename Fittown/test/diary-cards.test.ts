import { describe, expect, it } from 'vitest'
import {
  DIARY_CARD_IDS,
  diaryCardVisibility,
} from '../shared/diaryCards'

/**
 * The shared half of the Diary-cards preference: turning the stored
 * `diary_cards_hidden` value (a JSON array of hidden ids, or null) into
 * per-card visibility. The Diary page and the Settings screen must agree on
 * every one of these readings.
 */
describe('diaryCardVisibility', () => {
  it('defaults everything on', () => {
    const v = diaryCardVisibility(null)
    for (const id of DIARY_CARD_IDS) expect(v[id]).toBe(true)
  })

  it('treats an empty list as everything on', () => {
    const v = diaryCardVisibility('[]')
    for (const id of DIARY_CARD_IDS) expect(v[id]).toBe(true)
  })

  it('hides exactly the listed cards', () => {
    const v = diaryCardVisibility(JSON.stringify(['water', 'fitness']))
    expect(v.water).toBe(false)
    expect(v.fitness).toBe(false)
    expect(v.summary).toBe(true)
    expect(v.nutrition).toBe(true)
  })

  it('drops unknown ids instead of failing', () => {
    const v = diaryCardVisibility(JSON.stringify(['water', 'no_such_card']))
    expect(v.water).toBe(false)
    for (const id of DIARY_CARD_IDS.filter((c) => c !== 'water')) {
      expect(v[id]).toBe(true)
    }
  })

  it('reads corrupt JSON as everything on, never as a blank diary', () => {
    const v = diaryCardVisibility('{not json')
    for (const id of DIARY_CARD_IDS) expect(v[id]).toBe(true)
  })
})

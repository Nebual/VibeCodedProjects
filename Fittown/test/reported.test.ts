import { describe, expect, it } from 'vitest'
import { canReportFood, reportedFoodHidden } from '#shared/reported'

describe('canReportFood', () => {
  it('allows OFF and USDA-branded products', () => {
    expect(canReportFood({ source: 'off', owner_user_id: null }, 1)).toBe(true)
    expect(canReportFood({ source: 'usda_branded', owner_user_id: null }, 1)).toBe(true)
  })

  it('refuses a USDA Foundation Food — it is the named reference data', () => {
    expect(canReportFood({ source: 'usda_foundation', owner_user_id: null }, 1)).toBe(false)
  })

  it('refuses a custom food you own yourself, but allows someone else’s', () => {
    expect(canReportFood({ source: 'custom', owner_user_id: 1 }, 1)).toBe(false)
    expect(canReportFood({ source: 'custom', owner_user_id: 2 }, 1)).toBe(true)
  })

  it('allows recipes', () => {
    expect(canReportFood({ source: 'recipe', owner_user_id: 2 }, 1)).toBe(true)
  })
})

describe('reportedFoodHidden', () => {
  it('shows an unreported food to everyone', () => {
    expect(reportedFoodHidden({ source: 'off', owner_user_id: null, reported_by: null }, 1)).toBe(false)
  })

  it('hides a reported food from everyone except a custom food’s owner', () => {
    const food = { source: 'custom', owner_user_id: 2, reported_by: 3 }
    // The reporter can't see it either — once flagged it is simply gone.
    expect(reportedFoodHidden(food, 3)).toBe(true)
    // A bystander can't.
    expect(reportedFoodHidden(food, 1)).toBe(true)
    // The owner always can.
    expect(reportedFoodHidden(food, 2)).toBe(false)
  })

  it('hides a reported OFF product from everyone — no owner to exempt', () => {
    const food = { source: 'off', owner_user_id: null, reported_by: 1 }
    expect(reportedFoodHidden(food, 1)).toBe(true)
    expect(reportedFoodHidden(food, 2)).toBe(true)
  })
})
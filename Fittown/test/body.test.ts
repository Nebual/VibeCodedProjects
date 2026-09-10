import { describe, expect, it } from 'vitest'
import {
  BMI_CATEGORIES,
  CM_PER_IN,
  DEFAULT_RATE_KG_PER_WEEK,
  KCAL_PER_KG,
  KG_PER_LB,
  MAX_SAFE_RATE_KG,
  GOAL_TO_MAINTENANCE,
  ACTIVITY_LEVELS,
  activityLevel,
  bmi,
  bmiCategory,
  bmr,
  calorieTone,
  weightForBmi,
  calorieFloor,
  cmToFtIn,
  dailyDeltaToRate,
  daysToGoal,
  formatHeight,
  formatWeight,
  ftInToCm,
  kgToLb,
  lbToKg,
  maintenanceCalories,
  maintenanceForChart,
  planFromCalories,
  planFromRate,
  ratePresets,
  rateToDailyDelta,
} from '#shared/body'

/**
 * The reference profile used throughout: the same one the e2e script drives,
 * so a failure here and a failure there point at the same arithmetic.
 * 41-year-old female, 168 cm, 72.5 kg, moderately active.
 */
const PROFILE = { sex: 'female' as const, age: 41, heightCm: 168, weightKg: 72.5 }

describe('unit conversions', () => {
  it('uses the exact international definitions', () => {
    // A pound is defined as exactly 0.45359237 kg and an inch as exactly
    // 2.54 cm. Rounded constants drift visibly at bodyweight scale.
    expect(KG_PER_LB).toBe(0.45359237)
    expect(CM_PER_IN).toBe(2.54)
  })

  it('round-trips weight without losing precision', () => {
    for (const kg of [45, 72.5, 100, 158.9]) {
      expect(lbToKg(kgToLb(kg))).toBeCloseTo(kg, 10)
    }
  })

  it('converts a known weight both ways', () => {
    expect(kgToLb(100)).toBeCloseTo(220.462, 3)
    expect(lbToKg(160)).toBeCloseTo(72.575, 3)
  })

  it('splits centimetres into feet and inches', () => {
    expect(cmToFtIn(168)).toEqual({ ft: 5, in: 6 })
    expect(cmToFtIn(180)).toEqual({ ft: 5, in: 11 })
    // 152.4 cm is exactly five feet, and must not come back as 4' 12".
    expect(cmToFtIn(152.4)).toEqual({ ft: 5, in: 0 })
  })

  it('round-trips height to within the half inch it rounds to', () => {
    // Imperial height is entered in whole inches, so the round trip can only
    // ever be accurate to ±½ inch (1.27 cm). Asserting anything tighter tests
    // the arithmetic of the examples rather than the guarantee.
    for (const cm of [150, 168, 175, 190]) {
      const { ft, in: inches } = cmToFtIn(cm)
      expect(Math.abs(ftInToCm(ft, inches) - cm)).toBeLessThanOrEqual(CM_PER_IN / 2)
    }
  })

  it('formats in the requested unit, never the stored one', () => {
    expect(formatWeight(72.5, 'kg')).toBe('72.5 kg')
    expect(formatWeight(72.5, 'lb')).toBe('159.8 lb')
    expect(formatHeight(168, 'cm')).toBe('168 cm')
    expect(formatHeight(168, 'ftin')).toBe('5′ 6″')
  })

  it('renders an absent measurement as a dash rather than zero', () => {
    expect(formatWeight(null, 'kg')).toBe('—')
    expect(formatHeight(undefined, 'cm')).toBe('—')
  })
})

describe('Mifflin-St Jeor', () => {
  it('matches the published equation for a woman', () => {
    // 10(72.5) + 6.25(168) - 5(41) - 161 = 1409
    expect(bmr(PROFILE)).toBeCloseTo(1409, 6)
  })

  it('matches the published equation for a man', () => {
    // Same body, +5 instead of -161.
    expect(bmr({ ...PROFILE, sex: 'male' })).toBeCloseTo(1575, 6)
  })

  it('puts "prefer not to say" exactly midway between the two', () => {
    const female = bmr({ ...PROFILE, sex: 'female' })
    const male = bmr({ ...PROFILE, sex: 'male' })
    expect(bmr({ ...PROFILE, sex: 'unspecified' })).toBeCloseTo((female + male) / 2, 6)
  })

  it('falls with age and rises with mass', () => {
    expect(bmr({ ...PROFILE, age: 61 })).toBeLessThan(bmr(PROFILE))
    expect(bmr({ ...PROFILE, weightKg: 82.5 })).toBeGreaterThan(bmr(PROFILE))
  })
})

describe('activity levels', () => {
  it('carries the standard Harris-Benedict factors', () => {
    expect(ACTIVITY_LEVELS.map((a) => a.multiplier)).toEqual([1.2, 1.375, 1.55, 1.725, 1.9])
  })

  it('increases strictly with each step up', () => {
    const factors = ACTIVITY_LEVELS.map((a) => a.multiplier)
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]!).toBeGreaterThan(factors[i - 1]!)
    }
  })

  it('explains every level, because people overestimate their own', () => {
    for (const level of ACTIVITY_LEVELS) {
      expect(level.summary.length).toBeGreaterThan(10)
      expect(level.detail.length).toBeGreaterThan(60)
    }
  })

  it('produces the maintenance figure the calculator shows', () => {
    // 1409 x 1.55 = 2183.95, displayed as 2184.
    expect(Math.round(maintenanceCalories(PROFILE, 'moderate'))).toBe(2184)
  })

  it('falls back to sedentary for an unknown level', () => {
    expect(activityLevel('nonsense')).toBeNull()
    expect(maintenanceCalories(PROFILE, 'nonsense' as never)).toBeCloseTo(bmr(PROFILE) * 1.2, 6)
  })
})

describe('rate and calorie targets', () => {
  it('converts a weekly rate to a daily calorie delta', () => {
    // 0.5 kg/week x 7700 kcal/kg / 7 days = 550 kcal/day.
    expect(rateToDailyDelta(0.5)).toBeCloseTo(550, 6)
    expect(rateToDailyDelta(-0.5)).toBeCloseTo(-550, 6)
    expect(KCAL_PER_KG).toBe(7700)
  })

  it('round-trips rate through calories', () => {
    for (const rate of [-1, -0.25, 0, 0.5, 1]) {
      expect(dailyDeltaToRate(rateToDailyDelta(rate))).toBeCloseTo(rate, 10)
    }
  })

  it('builds the plan the dialog displays', () => {
    const plan = planFromRate(PROFILE, 'moderate', -0.5)
    expect(Math.round(plan.maintenance)).toBe(2184)
    expect(Math.round(plan.dailyDelta)).toBe(-550)
    expect(Math.round(plan.targetCalories)).toBe(1634)
  })

  it('derives the same plan from either direction', () => {
    const fromRate = planFromRate(PROFILE, 'moderate', -0.5)
    const fromCalories = planFromCalories(PROFILE, 'moderate', fromRate.targetCalories)
    expect(fromCalories.rateKgPerWeek).toBeCloseTo(-0.5, 10)
    expect(fromCalories.dailyDelta).toBeCloseTo(fromRate.dailyDelta, 10)
  })

  it('treats a positive rate as a surplus, so gaining works', () => {
    const plan = planFromRate(PROFILE, 'moderate', 0.25)
    expect(plan.dailyDelta).toBeGreaterThan(0)
    expect(plan.targetCalories).toBeGreaterThan(plan.maintenance)
  })

  it('defaults to half a pound a week', () => {
    expect(DEFAULT_RATE_KG_PER_WEEK).toBeCloseTo(lbToKg(0.5), 10)
    // Which is what a metric user sees in the box.
    expect(Number(DEFAULT_RATE_KG_PER_WEEK.toFixed(2))).toBe(0.23)
  })
})

describe('safety rails', () => {
  it('sets the floors used to warn about very low targets', () => {
    expect(calorieFloor('female')).toBe(1200)
    expect(calorieFloor('male')).toBe(1500)
    // Unknown sex takes the more cautious of the two.
    expect(calorieFloor('unspecified')).toBe(1200)
  })

  it('flags a kilo a week as the ceiling', () => {
    expect(MAX_SAFE_RATE_KG).toBe(1)
  })
})

describe('goal projection', () => {
  it('counts the days to reach a goal at a given rate', () => {
    // 5 kg to lose at 0.5 kg/week is 10 weeks.
    expect(daysToGoal(80, 75, -0.5)).toBe(70)
    expect(daysToGoal(70, 75, 0.5)).toBe(70)
  })

  it('refuses to project when the rate points the wrong way', () => {
    // Gaining will never reach a lower goal, however long you wait.
    expect(daysToGoal(80, 75, 0.5)).toBeNull()
    expect(daysToGoal(75, 80, -0.5)).toBeNull()
  })

  it('refuses to project at maintenance', () => {
    expect(daysToGoal(80, 75, 0)).toBeNull()
  })
})

describe('BMI', () => {
  it('matches the standard formula', () => {
    // 72.5 / 1.68^2 = 25.69...
    expect(bmi(PROFILE.weightKg, PROFILE.heightCm)).toBeCloseTo(25.69, 2)
  })

  it('covers every value with no gaps or overlaps', () => {
    for (const value of [10, 18.49, 18.5, 24.99, 25, 29.99, 30, 30.01, 60]) {
      expect(bmiCategory(value)).toBeDefined()
    }
    // Boundaries belong to the band starting there, not the one below.
    expect(bmiCategory(18.5).key).toBe('healthy')
    expect(bmiCategory(25).key).toBe('overweight')
    expect(bmiCategory(30).key).toBe('obese')
  })

  it('sorts categories from lightest to heaviest', () => {
    expect(BMI_CATEGORIES.map((c) => c.key)).toEqual([
      'underweight',
      'healthy',
      'overweight',
      'obese',
    ])
  })

  it('categorizes a known profile', () => {
    // 25.69 falls just past the healthy/overweight boundary at 25.
    expect(bmiCategory(bmi(PROFILE.weightKg, PROFILE.heightCm)).key).toBe('overweight')
  })

  it('inverts bmi() — the weight at this height for a target BMI', () => {
    for (const value of [18.5, 22, 25, 30]) {
      expect(bmi(weightForBmi(value, PROFILE.heightCm), PROFILE.heightCm)).toBeCloseTo(value, 10)
    }
  })

  it('gives a heavier person a higher weight at the same BMI', () => {
    expect(weightForBmi(25, 180)).toBeGreaterThan(weightForBmi(25, 160))
  })
})

describe('rate presets', () => {
  it('offers whole imperial steps to imperial users', () => {
    expect(ratePresets('lb').map((p) => p.label)).toEqual(['0.5 lb', '1 lb', '1.5 lb', '2 lb'])
    expect(ratePresets('lb')[0]!.kgPerWeek).toBeCloseTo(lbToKg(0.5), 10)
  })

  it('offers metric steps to metric users', () => {
    expect(ratePresets('kg').map((p) => p.label)).toEqual(['0.25 kg', '0.5 kg', '0.75 kg', '1 kg'])
    expect(ratePresets('kg')[3]!.kgPerWeek).toBe(1)
  })

  it('never suggests a rate above the safe ceiling', () => {
    for (const unit of ['kg', 'lb'] as const) {
      for (const preset of ratePresets(unit)) {
        expect(preset.kgPerWeek).toBeLessThanOrEqual(MAX_SAFE_RATE_KG)
      }
    }
  })
})

describe('maintenanceForChart', () => {
  it('uses the real equation when every body metric is known', () => {
    const estimate = maintenanceForChart(PROFILE, 'moderate', 1880)
    expect(estimate.approximate).toBe(false)
    expect(estimate.kcal).toBeCloseTo(maintenanceCalories(PROFILE, 'moderate'), 10)
  })

  it('treats a missing activity level as sedentary rather than as unknown', () => {
    // Every other metric is there, so this is still a real figure — just the
    // most conservative one, matching `maintenanceCalories`' own default.
    const estimate = maintenanceForChart(PROFILE, null, 1880)
    expect(estimate.approximate).toBe(false)
    expect(estimate.kcal).toBeCloseTo(bmr(PROFILE) * 1.2, 10)
  })

  it('scales off the calorie goal when a metric is missing', () => {
    for (const missing of [{ sex: null }, { age: null }, { heightCm: null }, { weightKg: null }]) {
      const estimate = maintenanceForChart({ ...PROFILE, ...missing }, 'moderate', 1880)
      expect(estimate.approximate).toBe(true)
      expect(estimate.kcal).toBeCloseTo(1880 * GOAL_TO_MAINTENANCE, 10)
    }
  })

  it('always estimates maintenance above the goal it was scaled from', () => {
    // Otherwise the red band would start below the amber one and no bar could
    // ever be merely "over goal".
    expect(GOAL_TO_MAINTENANCE).toBeGreaterThan(1)
  })

  it('lands within a sane distance of the real figure for the reference profile', () => {
    // The stand-in is a guess, but a guess that came out at half or double the
    // truth would be worse than drawing no line at all.
    const real = maintenanceCalories(PROFILE, 'moderate')
    const guess = maintenanceForChart({ ...PROFILE, sex: null }, 'moderate', 1880).kcal
    expect(Math.abs(guess - real) / real).toBeLessThan(0.15)
  })
})

describe('calorieTone', () => {
  const GOAL = 1880
  const MAINTENANCE = 2480

  it('leaves a day at or under the goal alone', () => {
    expect(calorieTone(1850, GOAL, MAINTENANCE)).toBe('under')
    expect(calorieTone(GOAL, GOAL, MAINTENANCE)).toBe('under')
  })

  it('warns between the goal and maintenance — over target, still losing', () => {
    expect(calorieTone(2100, GOAL, MAINTENANCE)).toBe('over-goal')
    expect(calorieTone(MAINTENANCE, GOAL, MAINTENANCE)).toBe('over-goal')
  })

  it('only calls it over-maintenance once the day is a real surplus', () => {
    expect(calorieTone(2481, GOAL, MAINTENANCE)).toBe('over-maintenance')
  })

  it('never reddens a bar under the goal, even on a bulk where the goal is higher', () => {
    // goal 3000 on a 2480 maintenance: eating 2600 is under target and must
    // not read as a warning, let alone as a blowout.
    expect(calorieTone(2600, 3000, MAINTENANCE)).toBe('under')
    expect(calorieTone(3100, 3000, MAINTENANCE)).toBe('over-maintenance')
  })
})

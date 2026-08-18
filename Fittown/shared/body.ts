/**
 * Body metrics, activity levels and energy maths.
 *
 * Shared by the settings UI (which does the arithmetic live as you type) and
 * the server (which validates what comes back). Keeping one copy means the
 * number you were shown is the number that gets stored.
 *
 * Everything here is an *estimate*. Predictive equations are fitted to
 * population averages and land within ~10% for most people; the honest use of
 * them is as a starting point you adjust once you see how your own weight
 * actually moves. The UI says so.
 */

// ---------------------------------------------------------------------------
// Units
//
// Heights are stored in cm and weights in kg, always. The unit choice is a
// display/entry preference, so a household can mix metric and imperial without
// two sets of numbers ever existing in the database.
// ---------------------------------------------------------------------------

export const KG_PER_LB = 0.45359237
export const CM_PER_IN = 2.54

export type WeightUnit = 'kg' | 'lb'
export type HeightUnit = 'cm' | 'ftin'

export const kgToLb = (kg: number) => kg / KG_PER_LB
export const lbToKg = (lb: number) => lb * KG_PER_LB
export const cmToIn = (cm: number) => cm / CM_PER_IN
export const inToCm = (inches: number) => inches * CM_PER_IN

/** Split centimetres into whole feet + inches, rounding inches to the nearest. */
export function cmToFtIn(cm: number): { ft: number; in: number } {
  const totalIn = Math.round(cmToIn(cm))
  return { ft: Math.floor(totalIn / 12), in: totalIn % 12 }
}

export function ftInToCm(ft: number, inches: number): number {
  return inToCm(ft * 12 + inches)
}

/** Format a stored kg value in the user's unit, e.g. "72.4 kg" / "159.6 lb". */
export function formatWeight(kg: number | null | undefined, unit: WeightUnit): string {
  if (kg === null || kg === undefined) return '—'
  return unit === 'lb' ? `${kgToLb(kg).toFixed(1)} lb` : `${kg.toFixed(1)} kg`
}

export function formatHeight(cm: number | null | undefined, unit: HeightUnit): string {
  if (cm === null || cm === undefined) return '—'
  if (unit === 'cm') return `${Math.round(cm)} cm`
  const { ft, in: inches } = cmToFtIn(cm)
  return `${ft}′ ${inches}″`
}

// ---------------------------------------------------------------------------
// Activity levels
// ---------------------------------------------------------------------------

export type ActivityKey = 'sedentary' | 'light' | 'moderate' | 'very' | 'extra'

export interface ActivityLevel {
  key: ActivityKey
  label: string
  /** Multiplier applied to BMR to get maintenance calories. */
  multiplier: number
  /** One line for the picker. */
  summary: string
  /** What this actually looks like in a week — the part people get wrong. */
  detail: string
}

/**
 * The standard Harris-Benedict activity factors, still the ones every
 * calculator uses. The `detail` text matters more than the number: most people
 * overestimate their level, and choosing "very active" when you are moderately
 * active is a ~500 kcal/day error — larger than most deliberate deficits.
 */
export const ACTIVITY_LEVELS: ActivityLevel[] = [
  {
    key: 'sedentary',
    label: 'Sedentary',
    multiplier: 1.2,
    summary: 'Little or no exercise',
    detail:
      'A desk job and no regular training. Everyday walking around the house, '
      + 'shops or office counts as sedentary — this is the baseline for "I do not '
      + 'work out".',
  },
  {
    key: 'light',
    label: 'Lightly active',
    multiplier: 1.375,
    summary: 'Light exercise 1–3 days a week',
    detail:
      'Roughly 20–40 minutes of easy exercise on a few days — a walk most days, '
      + 'a couple of gentle gym sessions, or a job that keeps you on your feet '
      + 'part of the day.',
  },
  {
    key: 'moderate',
    label: 'Moderately active',
    multiplier: 1.55,
    summary: 'Moderate exercise 3–5 days a week',
    detail:
      'About 30–60 minutes of real effort on most days — running, cycling, '
      + 'swimming or weights where you are breathing hard and sweating.',
  },
  {
    key: 'very',
    label: 'Very active',
    multiplier: 1.725,
    summary: 'Hard exercise 6–7 days a week',
    detail:
      'Hard training almost every day — an hour or more of demanding work, or a '
      + 'physically heavy job such as construction or farm work on top of some '
      + 'training.',
  },
  {
    key: 'extra',
    label: 'Extra active',
    multiplier: 1.9,
    summary: 'Hard daily exercise plus a physical job',
    detail:
      'Two training sessions a day, an endurance training block, or hard manual '
      + 'labour combined with daily training. Genuinely rare — pick this only if '
      + 'it describes a typical week, not your hardest one.',
  },
]

export const ACTIVITY_KEYS = ACTIVITY_LEVELS.map((a) => a.key)

export function activityLevel(key: string | null | undefined): ActivityLevel | null {
  return ACTIVITY_LEVELS.find((a) => a.key === key) ?? null
}

// ---------------------------------------------------------------------------
// Energy
// ---------------------------------------------------------------------------

export type Sex = 'male' | 'female' | 'unspecified'

export interface BodyInput {
  sex: Sex
  age: number
  weightKg: number
  heightCm: number
}

/**
 * Mifflin-St Jeor resting metabolic rate — the equation with the best track
 * record against measured RMR in non-obese and obese adults alike, which is
 * why it displaced Harris-Benedict as the default.
 *
 * The male and female constants differ only by a fixed 166 kcal offset (+5 vs
 * -161), standing in for average differences in lean mass. There is no
 * published third variant, so "prefer not to say" takes the midpoint: the
 * worst case is an ~83 kcal/day error, well inside the equation's own margin.
 */
export function bmr({ sex, age, weightKg, heightCm }: BodyInput): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  if (sex === 'male') return base + 5
  if (sex === 'female') return base - 161
  return base - 78 // midpoint of +5 and -161
}

/** Maintenance calories: resting burn scaled by how much you move. */
export function maintenanceCalories(body: BodyInput, activity: ActivityKey): number {
  return bmr(body) * (activityLevel(activity)?.multiplier ?? 1.2)
}

/**
 * Energy in a kilogram of body tissue.
 *
 * The familiar 3,500 kcal/lb (7,700 kcal/kg) figure treats the tissue as pure
 * fat. Real weight change includes some lean tissue and water, so actual loss
 * usually runs a little ahead of this early on and behind it later. Good
 * enough to set a target from; not a promise.
 */
export const KCAL_PER_KG = 7700

/** Daily calorie delta implied by a weekly rate of change. */
export const rateToDailyDelta = (kgPerWeek: number) => (kgPerWeek * KCAL_PER_KG) / 7

/** Weekly rate of change implied by a daily calorie delta. */
export const dailyDeltaToRate = (kcalPerDay: number) => (kcalPerDay * 7) / KCAL_PER_KG

/**
 * Lowest daily intake worth suggesting.
 *
 * 1,200 kcal (women) / 1,500 kcal (men) are the long-standing floors below
 * which it gets hard to hit micronutrient requirements from food alone. We
 * warn rather than block: this is the user's own diary, and anyone eating
 * below this on purpose should be doing it with medical supervision, not
 * fighting their tracker.
 */
export function calorieFloor(sex: Sex): number {
  if (sex === 'male') return 1500
  if (sex === 'female') return 1200
  return 1200
}

/** Fastest weekly change generally considered sustainable, in kg. */
export const MAX_SAFE_RATE_KG = 1

/**
 * Where the rate picker starts: half a pound a week.
 *
 * Slow enough to be sustainable and to spare lean mass, fast enough to show up
 * on the scale within a fortnight. Defined in pounds and converted, so the
 * default is the same plan for a metric and an imperial household (0.23 kg)
 * rather than two different ones.
 */
export const DEFAULT_RATE_KG_PER_WEEK = lbToKg(0.5)

export interface TargetPlan {
  /** Calories per day at the chosen rate. */
  targetCalories: number
  /** Maintenance calories, for comparison. */
  maintenance: number
  /** Negative = deficit, positive = surplus. */
  dailyDelta: number
  /** Negative = losing, positive = gaining. */
  rateKgPerWeek: number
}

export function planFromRate(
  body: BodyInput,
  activity: ActivityKey,
  rateKgPerWeek: number,
): TargetPlan {
  const maintenance = maintenanceCalories(body, activity)
  const dailyDelta = rateToDailyDelta(rateKgPerWeek)
  return {
    maintenance,
    dailyDelta,
    rateKgPerWeek,
    targetCalories: maintenance + dailyDelta,
  }
}

export function planFromCalories(
  body: BodyInput,
  activity: ActivityKey,
  targetCalories: number,
): TargetPlan {
  const maintenance = maintenanceCalories(body, activity)
  const dailyDelta = targetCalories - maintenance
  return {
    maintenance,
    dailyDelta,
    targetCalories,
    rateKgPerWeek: dailyDeltaToRate(dailyDelta),
  }
}

/**
 * Days to travel from `fromKg` to `goalKg` at `rateKgPerWeek`.
 * Null when the rate is zero or pointing the wrong way.
 */
export function daysToGoal(
  fromKg: number,
  goalKg: number,
  rateKgPerWeek: number,
): number | null {
  const remaining = goalKg - fromKg
  if (!rateKgPerWeek || Math.sign(remaining) !== Math.sign(rateKgPerWeek)) return null
  return Math.ceil(Math.abs(remaining / rateKgPerWeek) * 7)
}

/** Preset rates offered in the picker, in the user's own unit. */
export function ratePresets(unit: WeightUnit): { label: string; kgPerWeek: number }[] {
  if (unit === 'lb') {
    return [0.5, 1, 1.5, 2].map((lb) => ({
      label: `${lb} lb`,
      kgPerWeek: lbToKg(lb),
    }))
  }
  return [0.25, 0.5, 0.75, 1].map((kg) => ({ label: `${kg} kg`, kgPerWeek: kg }))
}

/** Matches the `calorie_goal` column default in server/db/schema.ts. */
export const DEFAULT_CALORIE_GOAL = 2000

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/**
 * A flat "8 glasses a day" ignores body size and how much you move, which is
 * why NASEM/IOM, EFSA and sports-nutrition guidance all scale water needs off
 * body weight instead. 30-35 mL/kg/day is the standard baseline (higher for
 * more active people); it lands close to NASEM's adequate-intake figures for
 * an average adult (3.7 L/day for a ~70 kg man, 2.7 L for a ~60 kg woman)
 * without a separate sex constant — weight already carries most of that
 * difference. Activity level doubles as the exercise adjustment, since it's
 * already collected for the calorie estimate above and already stands for a
 * typical week's training.
 */
const WATER_ML_PER_KG: Record<ActivityKey, number> = {
  sedentary: 30,
  light: 32,
  moderate: 35,
  very: 38,
  extra: 40,
}

/**
 * Suggested daily water-from-drinks target, in mL.
 *
 * This is total fluid intake, not the ~20% of water that ordinarily comes
 * from food — the number an app should ask you to actually drink. An
 * estimate like the calorie figures above: hot climates, illness, pregnancy
 * and breastfeeding all raise real needs beyond it.
 */
export function waterGoalMl(weightKg: number, activity: ActivityKey | null | undefined): number {
  const factor = WATER_ML_PER_KG[activity ?? 'sedentary'] ?? WATER_ML_PER_KG.sedentary
  return weightKg * factor
}

// ---------------------------------------------------------------------------
// BMI
// ---------------------------------------------------------------------------

export interface BmiCategory {
  key: 'underweight' | 'healthy' | 'overweight' | 'obese'
  label: string
  /** Inclusive lower bound; null means no lower bound. */
  min: number | null
  /** Exclusive upper bound; null means no upper bound. */
  max: number | null
}

/**
 * The WHO adult BMI bands, used worldwide. Fitted to population averages, so
 * it reads muscle as weight the same as fat — a heavily-trained person can
 * land in "overweight" with a low body-fat percentage. A starting signal, not
 * a diagnosis, which is why the UI shows the whole table rather than just a
 * single verdict.
 */
export const BMI_CATEGORIES: BmiCategory[] = [
  { key: 'underweight', label: 'Underweight', min: null, max: 18.5 },
  { key: 'healthy', label: 'Healthy weight', min: 18.5, max: 25 },
  { key: 'overweight', label: 'Overweight', min: 25, max: 30 },
  { key: 'obese', label: 'Obese', min: 30, max: null },
]

export function bmi(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100
  return weightKg / (heightM * heightM)
}

/** The bands are contiguous and unbounded at both ends, so this always matches. */
export function bmiCategory(value: number): BmiCategory {
  return (
    BMI_CATEGORIES.find(
      (c) => (c.min === null || value >= c.min) && (c.max === null || value < c.max),
    ) ?? BMI_CATEGORIES[BMI_CATEGORIES.length - 1]!
  )
}

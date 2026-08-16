/**
 * The activity library: what you can log, where it appears, and what it costs.
 *
 * ## Where the numbers come from
 *
 * MET values are taken from the **2024 Adult Compendium of Physical
 * Activities** (pacompendium.com), the successor to the 2011 Compendium. One
 * MET is roughly 1 kcal per kg of body weight per hour, so the estimate is
 * `MET x kg x hours` — the same formula the server has always used.
 *
 * The Compendium's own intensity bands are light < 3.0, moderate 3.0–5.9 and
 * vigorous >= 6.0 METs, but those describe the *activity*, not how hard you
 * personally went at it. So where the Compendium lists measured light /
 * moderate / vigorous rows for an activity, we carry all three and let the
 * user pick. Vacuuming is vacuuming; scrubbing a bathroom floor is 2.0 METs
 * dawdling and 6.5 flat out, and pretending otherwise loses a factor of three.
 *
 * Some activities only have one or two measured rows. Where a middle value is
 * interpolated between measured anchors it is marked `estimated` — those are
 * the ones to fix first if someone ever gets access to the full data set.
 *
 * ## Effort is optional
 *
 * `met: number` means effort doesn't meaningfully change the cost (washing
 * dishes, table tennis) and the UI won't ask. Only activities with a
 * three-value MET get an effort picker.
 */

export type EffortKey = 'light' | 'moderate' | 'hard'

/**
 * Effort descriptions are deliberately about *breathing*, not speed or watts.
 * It's the one self-report cue people can apply honestly across walking,
 * scrubbing floors and squash alike.
 */
export const EFFORT_LEVELS: {
  key: EffortKey
  label: string
  description: string
}[] = [
  {
    key: 'light',
    label: 'Light',
    description:
      'Requires some effort, but not enough to speed up your breathing.',
  },
  {
    key: 'moderate',
    label: 'Moderate',
    description:
      'Requires moderate effort. Speeds up your heart rate and breathing, '
      + 'but does not leave you out of breath.',
  },
  {
    key: 'hard',
    label: 'Hard',
    description:
      'Requires vigorous effort. Gets your heart pounding and makes your '
      + 'breathing very fast.',
  },
]

export const EFFORT_KEYS = EFFORT_LEVELS.map((e) => e.key)

export function effortLevel(key: string | null | undefined) {
  return EFFORT_LEVELS.find((e) => e.key === key) ?? null
}

// ---------------------------------------------------------------------------
// Categories
//
// An activity belongs to as many of these as make sense — cycling is both
// cardio and outdoor, gardening is both household and outdoor — because people
// look for things where they expect them, not where a taxonomy filed them.
// ---------------------------------------------------------------------------

export type CategoryKey =
  | 'cardio'
  | 'gym'
  | 'strength'
  | 'mobility'
  | 'sports'
  | 'outdoor'
  | 'household'
  | 'occupational'

export const ACTIVITY_CATEGORIES: {
  key: CategoryKey
  label: string
  icon: string
  blurb: string
}[] = [
  { key: 'cardio', label: 'Cardio', icon: 'heart', blurb: 'Running, cycling, swimming' },
  { key: 'gym', label: 'Gym', icon: 'dumbbell', blurb: 'Machines, classes, circuits' },
  { key: 'strength', label: 'Strength', icon: 'barbell', blurb: 'Lifting and bodyweight' },
  { key: 'mobility', label: 'Mobility', icon: 'stretch', blurb: 'Yoga, pilates, stretching' },
  { key: 'sports', label: 'Sports', icon: 'ball', blurb: 'Team games and racket sports' },
  { key: 'outdoor', label: 'Outdoors', icon: 'mountain', blurb: 'Hiking, paddling, snow' },
  { key: 'household', label: 'Household', icon: 'home', blurb: 'Chores, garden, repairs' },
  { key: 'occupational', label: 'At work', icon: 'briefcase', blurb: 'Physical work on the job' },
]

export function activityCategory(key: string | null | undefined) {
  return ACTIVITY_CATEGORIES.find((c) => c.key === key) ?? null
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export type MetSpec = number | Record<EffortKey, number>

export interface ActivityDef {
  name: string
  categories: CategoryKey[]
  met: MetSpec
  /** Extra fields worth collecting for this activity. */
  tracks?: ('distance' | 'sets')[]
  /** Anchors the effort levels to something concrete, where a pace exists. */
  hint?: string
  /** True when a middle value was interpolated rather than measured. */
  estimated?: boolean
}

/**
 * Roughly ninety activities, chosen to cover a normal household's week rather
 * than to mirror the Compendium's 1,114 codes. Anything missing can still be
 * added by the user as a custom exercise.
 */
export const ACTIVITIES: ActivityDef[] = [
  // --- Walking, running -----------------------------------------------------
  {
    name: 'Walking',
    categories: ['cardio', 'outdoor'],
    met: { light: 2.8, moderate: 3.8, hard: 5.5 },
    tracks: ['distance'],
    hint: 'Light ≈ 3.5 km/h, moderate ≈ 5 km/h, hard ≈ 7 km/h',
  },
  {
    name: 'Walking the dog',
    categories: ['cardio', 'outdoor', 'household'],
    met: 3.0,
    tracks: ['distance'],
  },
  {
    name: 'Hiking',
    categories: ['outdoor', 'cardio'],
    met: { light: 3.8, moderate: 5.3, hard: 7.8 },
    tracks: ['distance'],
    hint: 'Hard covers hills or carrying a daypack',
  },
  {
    name: 'Running',
    categories: ['cardio', 'outdoor'],
    met: { light: 6.5, moderate: 9.3, hard: 12.0 },
    tracks: ['distance'],
    hint: 'Light ≈ 6.5 km/h, moderate ≈ 9.7 km/h, hard ≈ 13 km/h',
  },
  { name: 'Jogging', categories: ['cardio', 'outdoor'], met: 7.5, tracks: ['distance'] },
  {
    name: 'Treadmill',
    categories: ['cardio', 'gym'],
    met: { light: 4.8, moderate: 8.5, hard: 11.0 },
    tracks: ['distance'],
  },
  { name: 'Stair climbing', categories: ['cardio', 'outdoor'], met: 8.0 },
  { name: 'Stair machine', categories: ['gym', 'cardio'], met: 9.3 },

  // --- Cycling --------------------------------------------------------------
  {
    name: 'Cycling',
    categories: ['cardio', 'outdoor'],
    met: { light: 4.0, moderate: 8.0, hard: 12.0 },
    tracks: ['distance'],
    hint: 'Light < 16 km/h, moderate ≈ 20 km/h, hard ≈ 26 km/h',
  },
  {
    name: 'Mountain biking',
    categories: ['outdoor', 'cardio'],
    met: { light: 6.8, moderate: 8.5, hard: 14.0 },
    tracks: ['distance'],
    estimated: true,
  },
  {
    name: 'Stationary bike',
    categories: ['gym', 'cardio'],
    met: { light: 4.0, moderate: 6.0, hard: 10.8 },
    hint: 'Roughly 30 W, 85 W and 225 W',
  },
  {
    name: 'Spin class',
    categories: ['gym', 'cardio'],
    met: { light: 5.8, moderate: 8.0, hard: 10.8 },
    estimated: true,
  },

  // --- Water ----------------------------------------------------------------
  {
    name: 'Swimming (laps)',
    categories: ['cardio', 'sports'],
    met: { light: 5.8, moderate: 7.5, hard: 9.8 },
    tracks: ['distance'],
    estimated: true,
  },
  { name: 'Swimming (leisure)', categories: ['cardio', 'outdoor'], met: 6.0 },
  { name: 'Water aerobics', categories: ['gym', 'cardio'], met: 5.3 },
  {
    name: 'Rowing machine',
    categories: ['gym', 'cardio', 'strength'],
    met: { light: 5.0, moderate: 7.3, hard: 11.0 },
    tracks: ['distance'],
    hint: 'Roughly under 100 W, 100–149 W and 150–199 W',
  },
  {
    name: 'Rowing (on water)',
    categories: ['outdoor', 'cardio'],
    met: { light: 2.8, moderate: 5.8, hard: 12.0 },
    tracks: ['distance'],
  },
  {
    name: 'Kayaking',
    categories: ['outdoor', 'cardio'],
    met: { light: 3.5, moderate: 5.0, hard: 9.5 },
    tracks: ['distance'],
    estimated: true,
  },
  {
    name: 'Canoeing',
    categories: ['outdoor', 'cardio'],
    met: { light: 2.8, moderate: 5.8, hard: 12.0 },
    tracks: ['distance'],
  },
  {
    name: 'Paddleboarding',
    categories: ['outdoor', 'cardio'],
    met: { light: 2.8, moderate: 6.5, hard: 11.0 },
  },
  {
    name: 'Surfing',
    categories: ['outdoor', 'sports'],
    met: { light: 3.0, moderate: 5.0, hard: 6.8 },
  },

  // --- Gym / conditioning ---------------------------------------------------
  {
    name: 'Elliptical trainer',
    categories: ['gym', 'cardio'],
    met: { light: 3.5, moderate: 5.0, hard: 9.0 },
    estimated: true,
  },
  {
    name: 'Rope skipping',
    categories: ['gym', 'cardio'],
    met: { light: 8.8, moderate: 11.0, hard: 12.3 },
  },
  {
    name: 'HIIT',
    categories: ['gym', 'cardio'],
    met: { light: 5.0, moderate: 7.0, hard: 11.0 },
    estimated: true,
  },
  {
    name: 'Aerobics class',
    categories: ['gym', 'cardio'],
    met: { light: 5.5, moderate: 7.3, hard: 9.0 },
    hint: 'Step height: 4 inch, 6–8 inch, 10–12 inch',
  },
  { name: 'Zumba', categories: ['gym', 'cardio'], met: 6.5 },
  { name: 'Boot camp / obstacle course', categories: ['gym', 'cardio'], met: 5.0 },
  { name: 'Teaching a fitness class', categories: ['occupational', 'gym'], met: 6.8 },

  // --- Strength -------------------------------------------------------------
  {
    name: 'Weight training',
    categories: ['strength', 'gym'],
    met: { light: 3.5, moderate: 5.0, hard: 6.0 },
    tracks: ['sets'],
    hint: 'Light = machines and 8–15 reps, hard = heavy compound lifts',
  },
  {
    name: 'Powerlifting',
    categories: ['strength', 'gym'],
    met: 6.0,
    tracks: ['sets'],
  },
  {
    name: 'Bodyweight exercises',
    categories: ['strength', 'gym'],
    met: { light: 2.8, moderate: 3.8, hard: 7.5 },
    tracks: ['sets'],
    hint: 'Light = planks and crunches, hard = burpees and jumping jacks',
  },
  {
    name: 'Circuit training',
    categories: ['gym', 'strength', 'cardio'],
    met: { light: 3.5, moderate: 5.0, hard: 7.5 },
    tracks: ['sets'],
  },
  {
    name: 'Kettlebells',
    categories: ['strength', 'gym'],
    met: { light: 5.0, moderate: 7.5, hard: 9.8 },
    tracks: ['sets'],
    estimated: true,
  },
  {
    name: 'CrossFit / functional fitness',
    categories: ['gym', 'strength', 'cardio'],
    met: { light: 5.0, moderate: 7.5, hard: 11.0 },
    tracks: ['sets'],
    estimated: true,
  },
  {
    name: 'Resistance bands',
    categories: ['strength', 'gym', 'mobility'],
    met: { light: 2.8, moderate: 3.5, hard: 5.0 },
    tracks: ['sets'],
    estimated: true,
  },

  // --- Mobility -------------------------------------------------------------
  {
    name: 'Yoga',
    categories: ['mobility', 'gym'],
    met: { light: 2.3, moderate: 3.0, hard: 4.0 },
    hint: 'Light = Hatha, moderate = hot yoga, hard = power yoga',
  },
  {
    name: 'Pilates',
    categories: ['mobility', 'gym'],
    met: { light: 1.8, moderate: 2.8, hard: 3.5 },
  },
  { name: 'Stretching', categories: ['mobility'], met: 2.3 },
  { name: 'Foam rolling', categories: ['mobility'], met: 2.3, estimated: true },
  { name: 'Tai chi', categories: ['mobility'], met: 3.0 },
  { name: 'Balance training', categories: ['mobility'], met: 2.3 },
  { name: 'Physio / rehab exercises', categories: ['mobility'], met: 2.8 },

  // --- Sports ---------------------------------------------------------------
  {
    name: 'Football (soccer)',
    categories: ['sports', 'outdoor'],
    met: { light: 5.0, moderate: 7.0, hard: 9.5 },
    estimated: true,
  },
  {
    name: 'Basketball',
    categories: ['sports'],
    met: { light: 4.5, moderate: 6.0, hard: 8.0 },
    estimated: true,
  },
  {
    name: 'Tennis',
    categories: ['sports'],
    met: { light: 5.0, moderate: 6.8, hard: 8.0 },
    hint: 'Hard is singles at pace',
    estimated: true,
  },
  {
    name: 'Badminton',
    categories: ['sports'],
    met: { light: 4.0, moderate: 5.5, hard: 9.0 },
    estimated: true,
  },
  {
    name: 'Squash',
    categories: ['sports'],
    met: { light: 5.5, moderate: 7.3, hard: 12.0 },
    estimated: true,
  },
  { name: 'Table tennis', categories: ['sports'], met: 4.0 },
  {
    name: 'Volleyball',
    categories: ['sports', 'outdoor'],
    met: { light: 3.0, moderate: 6.0, hard: 8.0 },
    hint: 'Hard is beach volleyball in sand',
  },
  { name: 'Golf (walking)', categories: ['sports', 'outdoor'], met: 4.3 },
  { name: 'Ice hockey', categories: ['sports'], met: 8.0 },
  { name: 'Cricket', categories: ['sports', 'outdoor'], met: 4.8 },
  { name: 'Baseball / softball', categories: ['sports', 'outdoor'], met: 5.0 },
  { name: 'American football', categories: ['sports', 'outdoor'], met: 8.0 },
  { name: 'Rugby', categories: ['sports', 'outdoor'], met: 8.3 },
  { name: 'Ultimate frisbee', categories: ['sports', 'outdoor'], met: 8.0 },
  {
    name: 'Boxing',
    categories: ['sports', 'gym'],
    met: { light: 4.0, moderate: 5.8, hard: 12.3 },
    hint: 'Moderate is bag work, hard is sparring in the ring',
  },
  {
    name: 'Martial arts',
    categories: ['sports', 'gym'],
    met: { light: 5.3, moderate: 10.3, hard: 11.0 },
    estimated: true,
  },
  {
    name: 'Climbing',
    categories: ['sports', 'outdoor', 'strength'],
    met: { light: 5.8, moderate: 8.0, hard: 11.0 },
    estimated: true,
  },
  { name: 'Skating', categories: ['sports', 'outdoor'], met: 7.0 },
  { name: 'Dancing', categories: ['sports', 'cardio'], met: { light: 3.5, moderate: 5.5, hard: 7.8 }, estimated: true },
  { name: 'Horse riding', categories: ['sports', 'outdoor'], met: 5.5, estimated: true },

  // --- Snow -----------------------------------------------------------------
  {
    name: 'Skiing (downhill)',
    categories: ['outdoor', 'sports'],
    met: { light: 4.3, moderate: 6.3, hard: 8.0 },
  },
  {
    name: 'Snowboarding',
    categories: ['outdoor', 'sports'],
    met: { light: 4.3, moderate: 6.3, hard: 8.0 },
  },
  {
    name: 'Cross-country skiing',
    categories: ['outdoor', 'cardio', 'sports'],
    met: { light: 6.8, moderate: 8.5, hard: 11.3 },
    tracks: ['distance'],
  },
  {
    name: 'Snowshoeing',
    categories: ['outdoor', 'cardio'],
    met: { light: 4.5, moderate: 5.3, hard: 10.0 },
    tracks: ['distance'],
    estimated: true,
  },

  // --- Household ------------------------------------------------------------
  {
    name: 'Cleaning',
    categories: ['household'],
    met: { light: 2.5, moderate: 3.3, hard: 3.8 },
  },
  {
    name: 'Sweeping',
    categories: ['household'],
    met: { light: 2.3, moderate: 3.3, hard: 3.8 },
  },
  { name: 'Vacuuming', categories: ['household'], met: 3.0 },
  {
    name: 'Mopping',
    categories: ['household'],
    met: { light: 2.5, moderate: 3.5, hard: 4.5 },
  },
  {
    name: 'Scrubbing floors or bathroom',
    categories: ['household'],
    met: { light: 2.0, moderate: 3.5, hard: 6.5 },
  },
  { name: 'Washing dishes', categories: ['household'], met: 2.0 },
  {
    name: 'Laundry',
    categories: ['household'],
    met: { light: 2.0, moderate: 2.3, hard: 4.0 },
  },
  {
    name: 'Cooking',
    categories: ['household'],
    met: { light: 2.0, moderate: 3.3, hard: 3.5 },
  },
  { name: 'Washing windows', categories: ['household'], met: 3.3 },
  { name: 'Washing the car', categories: ['household', 'outdoor'], met: 3.5 },
  {
    name: 'Moving furniture or boxes',
    categories: ['household', 'occupational'],
    met: { light: 5.0, moderate: 5.8, hard: 9.0 },
    hint: 'Hard is carrying it upstairs',
  },
  {
    name: 'Playing with children',
    categories: ['household'],
    met: { light: 2.8, moderate: 3.5, hard: 5.8 },
  },
  { name: 'Child care (infant)', categories: ['household'], met: 2.5 },
  { name: 'Grocery shopping', categories: ['household'], met: 2.3, estimated: true },
  {
    name: 'Home repair / DIY',
    categories: ['household', 'occupational'],
    met: { light: 2.5, moderate: 4.3, hard: 7.0 },
  },

  // --- Lawn and garden ------------------------------------------------------
  {
    name: 'Gardening',
    categories: ['household', 'outdoor'],
    met: { light: 2.0, moderate: 3.8, hard: 5.0 },
  },
  {
    name: 'Weeding',
    categories: ['household', 'outdoor'],
    met: { light: 3.8, moderate: 4.5, hard: 5.0 },
  },
  {
    name: 'Digging / spading',
    categories: ['household', 'outdoor'],
    met: { light: 3.5, moderate: 5.0, hard: 7.3 },
  },
  {
    name: 'Mowing the lawn',
    categories: ['household', 'outdoor'],
    met: { light: 2.5, moderate: 5.0, hard: 6.0 },
    hint: 'Light is a riding mower, hard is a push mower',
  },
  { name: 'Raking leaves', categories: ['household', 'outdoor'], met: 4.0 },
  {
    name: 'Shovelling snow',
    categories: ['household', 'outdoor'],
    met: { light: 5.3, moderate: 6.0, hard: 7.5 },
  },
  {
    name: 'Chopping wood',
    categories: ['household', 'outdoor'],
    met: { light: 4.1, moderate: 4.5, hard: 6.5 },
  },
  {
    name: 'Carrying or stacking wood',
    categories: ['household', 'outdoor', 'occupational'],
    met: { light: 4.1, moderate: 5.5, hard: 6.5 },
  },

  // --- Occupational ---------------------------------------------------------
  { name: 'Desk work', categories: ['occupational'], met: 1.3 },
  {
    name: 'Standing work',
    categories: ['occupational'],
    met: { light: 1.8, moderate: 2.5, hard: 3.3 },
    estimated: true,
  },
  {
    name: 'Custodial work',
    categories: ['occupational', 'household'],
    met: { light: 2.3, moderate: 3.8, hard: 4.5 },
    estimated: true,
  },
  {
    name: 'Patient care / nursing',
    categories: ['occupational'],
    met: { light: 2.3, moderate: 3.0, hard: 3.5 },
  },
  {
    name: 'Warehouse work',
    categories: ['occupational'],
    met: { light: 2.3, moderate: 4.0, hard: 7.5 },
    hint: 'Hard is repeatedly moving loads over 35 kg',
  },
  { name: 'Carrying heavy loads', categories: ['occupational'], met: 8.0 },
  {
    name: 'Construction',
    categories: ['occupational'],
    met: { light: 2.5, moderate: 4.3, hard: 7.0 },
  },
  {
    name: 'Carpentry',
    categories: ['occupational', 'household'],
    met: { light: 2.5, moderate: 4.3, hard: 7.0 },
  },
  {
    name: 'Farm work',
    categories: ['occupational', 'outdoor'],
    met: { light: 2.0, moderate: 4.8, hard: 7.8 },
  },
  { name: 'Driving (delivery / truck)', categories: ['occupational'], met: 2.0 },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const hasEffortLevels = (met: MetSpec): met is Record<EffortKey, number> =>
  typeof met !== 'number'

/** MET for a given effort, falling back to moderate when effort isn't set. */
export function metFor(met: MetSpec, effort?: EffortKey | null): number {
  if (!hasEffortLevels(met)) return met
  return met[effort ?? 'moderate']
}

/** The three columns stored on the exercises table. */
export function metColumns(met: MetSpec) {
  return hasEffortLevels(met)
    ? { met: met.moderate, met_light: met.light, met_hard: met.hard }
    : { met, met_light: null, met_hard: null }
}

/** kcal = MET x kg x hours. The whole model, in one line. */
export function estimateCalories(met: number, weightKg: number, minutes: number) {
  return met * weightKg * (minutes / 60)
}

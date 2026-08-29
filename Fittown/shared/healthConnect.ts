/**
 * Health Connect -> Fittown exercise mapping.
 *
 * The wire contract this app defines for POST /api/health/sync: a session's
 * `type` is one of the keys below. Health Connect's own SDK identifies
 * exercises by an integer `ExerciseType` constant, not a string — translating
 * that into one of these names is the phone app's job (docs/samsung-health-sync.md
 * §6, not yet built), which is also why this map doesn't need to be a
 * byte-perfect mirror of Android's enum: it only has to agree with whatever
 * the phone app is taught to send.
 *
 * Not exhaustive — Health Connect has roughly 80 exercise types and Fittown's
 * library (shared/activities.ts) has about 90 named activities. This covers
 * the overlap a household actually logs; anything else resolves to
 * FALLBACK_ACTIVITY_NAME rather than being dropped.
 */

/** What an unrecognised session `type` maps to. Defined in shared/activities.ts. */
export const FALLBACK_ACTIVITY_NAME = 'Tracked workout'

export const HEALTH_CONNECT_ACTIVITY_MAP: Record<string, string> = {
  WALKING: 'Walking',
  HIKING: 'Hiking',
  RUNNING: 'Running',
  RUNNING_TREADMILL: 'Treadmill',
  BIKING: 'Cycling',
  BIKING_STATIONARY: 'Stationary bike',
  SWIMMING_POOL: 'Swimming (laps)',
  SWIMMING_OPEN_WATER: 'Swimming (leisure)',
  ROWING: 'Rowing (on water)',
  ROWING_MACHINE: 'Rowing machine',
  ELLIPTICAL: 'Elliptical trainer',
  STAIR_CLIMBING: 'Stair climbing',
  STAIR_CLIMBING_MACHINE: 'Stair machine',
  STRENGTH_TRAINING: 'Weight training',
  WEIGHTLIFTING: 'Weight training',
  CALISTHENICS: 'Bodyweight exercises',
  HIGH_INTENSITY_INTERVAL_TRAINING: 'HIIT',
  YOGA: 'Yoga',
  PILATES: 'Pilates',
  STRETCHING: 'Stretching',
  BOXING: 'Boxing',
  MARTIAL_ARTS: 'Martial arts',
  ROCK_CLIMBING: 'Climbing',
  ICE_SKATING: 'Skating',
  BASKETBALL: 'Basketball',
  SOCCER: 'Football (soccer)',
  TENNIS: 'Tennis',
  BADMINTON: 'Badminton',
  SQUASH: 'Squash',
  TABLE_TENNIS: 'Table tennis',
  VOLLEYBALL: 'Volleyball',
  GOLF: 'Golf (walking)',
  ICE_HOCKEY: 'Ice hockey',
  FOOTBALL_AMERICAN: 'American football',
  RUGBY: 'Rugby',
  DANCING: 'Aerobics class',
  PADDLING: 'Paddleboarding',
  ROWING_OPEN_WATER: 'Rowing (on water)',
  SURFING: 'Surfing',
  CRICKET: 'Cricket',
  BASEBALL: 'Baseball / softball',
  SNOWSHOEING: 'Hiking',
}

/** Resolve a synced session's `type` to a Fittown activity name. */
export function mapHealthConnectType(type: string): string {
  return HEALTH_CONNECT_ACTIVITY_MAP[type] ?? FALLBACK_ACTIVITY_NAME
}

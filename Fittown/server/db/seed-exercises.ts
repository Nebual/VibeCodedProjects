/**
 * Starter exercise library: [name, category, MET].
 *
 * MET values are from the 2011 Compendium of Physical Activities. They drive
 * the default calorie estimate (kcal = MET x kg x hours) when the user doesn't
 * type in a figure from their watch.
 *
 * Strength entries carry a MET too, since a lifting session still burns
 * measurable energy even though reps/sets are the interesting part.
 */
export const SEED_EXERCISES: Array<[name: string, category: string, met: number]> = [
  // Walking / running
  ['Walking (slow, 3 km/h)', 'cardio', 2.8],
  ['Walking (moderate, 5 km/h)', 'cardio', 3.5],
  ['Walking (brisk, 6.5 km/h)', 'cardio', 5.0],
  ['Hiking', 'cardio', 6.0],
  ['Running (8 km/h)', 'cardio', 8.3],
  ['Running (10 km/h)', 'cardio', 9.8],
  ['Running (12 km/h)', 'cardio', 11.8],
  ['Treadmill', 'cardio', 8.0],
  ['Stair climbing', 'cardio', 8.8],

  // Cycling
  ['Cycling (leisure, 16 km/h)', 'cardio', 4.0],
  ['Cycling (moderate, 20 km/h)', 'cardio', 8.0],
  ['Cycling (vigorous, 25 km/h)', 'cardio', 10.0],
  ['Stationary bike', 'cardio', 7.0],
  ['Spinning class', 'cardio', 8.5],

  // Water
  ['Swimming (leisure)', 'cardio', 6.0],
  ['Swimming (laps, moderate)', 'cardio', 8.3],
  ['Rowing machine', 'cardio', 7.0],

  // Gym / studio
  ['Weight training (light)', 'strength', 3.5],
  ['Weight training (vigorous)', 'strength', 6.0],
  ['Bodyweight circuit', 'strength', 8.0],
  ['CrossFit', 'strength', 9.0],
  ['Kettlebells', 'strength', 8.0],
  ['Elliptical trainer', 'cardio', 5.0],
  ['HIIT', 'cardio', 10.0],
  ['Pilates', 'other', 3.0],
  ['Yoga', 'other', 3.0],
  ['Stretching', 'other', 2.3],

  // Sports
  ['Football (soccer)', 'cardio', 7.0],
  ['Basketball', 'cardio', 6.5],
  ['Tennis', 'cardio', 7.3],
  ['Badminton', 'cardio', 5.5],
  ['Golf (walking)', 'cardio', 4.8],
  ['Squash', 'cardio', 12.0],
  ['Table tennis', 'cardio', 4.0],
  ['Volleyball', 'cardio', 4.0],
  ['Skiing (downhill)', 'cardio', 6.0],
  ['Skating', 'cardio', 7.0],
  ['Boxing (bag work)', 'cardio', 7.8],
  ['Martial arts', 'cardio', 10.3],
  ['Climbing', 'strength', 8.0],
  ['Dancing', 'cardio', 5.0],

  // Everyday
  ['Housework', 'other', 3.3],
  ['Gardening', 'other', 3.8],
  ['Shovelling snow', 'other', 6.0],
  ['Playing with kids', 'other', 4.0],
]

/**
 * Log a workout.
 *
 * If the user didn't supply a calorie figure we estimate it from the
 * activity's MET value and their body weight:  kcal = MET x kg x hours.
 * That needs a weight, so we use the most recent one they've logged and fall
 * back to a stated default only when they've never entered one.
 */
const FALLBACK_WEIGHT_KG = 70

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const exerciseId = assertId(body.exercise_id, 'exercise_id')
  const durationMin = optionalNumber(body.duration_min, 'duration_min', { min: 0, max: 1440 })

  const db = useDb()
  const exercise = db
    .prepare(
      'SELECT id, met FROM exercises WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)',
    )
    .get(exerciseId, user.id) as { id: number; met: number | null } | undefined

  if (!exercise) throw createError({ statusCode: 404, statusMessage: 'Exercise not found' })

  let calories = optionalNumber(body.calories, 'calories', { min: 0, max: 20000 })

  if (calories === null && exercise.met && durationMin) {
    const recent = db
      .prepare(
        'SELECT weight_kg FROM weight_entries WHERE user_id = ? ORDER BY date DESC LIMIT 1',
      )
      .get(user.id) as { weight_kg: number } | undefined

    const kg = recent?.weight_kg ?? FALLBACK_WEIGHT_KG
    calories = exercise.met * kg * (durationMin / 60)
  }

  const info = db
    .prepare(
      `INSERT INTO workout_entries
         (user_id, date, exercise_id, duration_min, calories, sets, reps, weight_kg, distance_km, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      day,
      exerciseId,
      durationMin,
      calories === null ? null : Math.round(calories),
      optionalNumber(body.sets, 'sets', { min: 0, max: 100 }),
      optionalNumber(body.reps, 'reps', { min: 0, max: 1000 }),
      optionalNumber(body.weight_kg, 'weight_kg', { min: 0, max: 1000 }),
      optionalNumber(body.distance_km, 'distance_km', { min: 0, max: 1000 }),
      optionalText(body.notes, 500),
    )

  return { id: Number(info.lastInsertRowid), calories }
})

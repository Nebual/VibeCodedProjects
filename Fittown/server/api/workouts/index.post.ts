/**
 * Log a workout.
 *
 * If the user didn't supply a calorie figure we estimate it from the
 * activity's MET value and their body weight:  kcal = MET x kg x hours.
 * That needs a weight, so we use the most recent one they've logged and fall
 * back to a stated default only when they've never entered one.
 */
import { EFFORT_KEYS, estimateCalories, type EffortKey } from '#shared/activities'
import { FALLBACK_WEIGHT_KG } from '#shared/body'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const day = assertDate(body.date)
  const exerciseId = assertId(body.exercise_id, 'exercise_id')
  const durationMin = optionalNumber(body.duration_min, 'duration_min', { min: 0, max: 1440 })

  const effort = optionalText(body.effort, 20)
  if (effort !== null && !EFFORT_KEYS.includes(effort as EffortKey)) {
    throw createError({
      statusCode: 400,
      statusMessage: `effort must be one of: ${EFFORT_KEYS.join(', ')}`,
    })
  }

  const db = useDb()
  const exercise = db
    .prepare(
      `SELECT id, met, met_light, met_hard FROM exercises
       WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)`,
    )
    .get(exerciseId, user.id) as
    | { id: number; met: number | null; met_light: number | null; met_hard: number | null }
    | undefined

  if (!exercise) throw createError({ statusCode: 404, statusMessage: 'Exercise not found' })

  // `met` is the moderate value. The light/hard columns are null for
  // activities where effort doesn't change the cost, so fall back to it.
  const met =
    effort === 'light'
      ? exercise.met_light ?? exercise.met
      : effort === 'hard'
        ? exercise.met_hard ?? exercise.met
        : exercise.met

  let calories = optionalNumber(body.calories, 'calories', { min: 0, max: 20000 })

  if (calories === null && met && durationMin) {
    const recent = db
      .prepare(
        'SELECT weight_kg FROM weight_entries WHERE user_id = ? ORDER BY date DESC LIMIT 1',
      )
      .get(user.id) as { weight_kg: number } | undefined

    const kg = recent?.weight_kg ?? FALLBACK_WEIGHT_KG
    calories = estimateCalories(met, kg, durationMin)
  }

  const info = db
    .prepare(
      `INSERT INTO workout_entries
         (user_id, date, exercise_id, duration_min, calories, effort, sets, reps, weight_kg, distance_km, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      day,
      exerciseId,
      durationMin,
      calories === null ? null : Math.round(calories),
      effort,
      optionalNumber(body.sets, 'sets', { min: 0, max: 100 }),
      optionalNumber(body.reps, 'reps', { min: 0, max: 1000 }),
      optionalNumber(body.weight_kg, 'weight_kg', { min: 0, max: 1000 }),
      optionalNumber(body.distance_km, 'distance_km', { min: 0, max: 1000 }),
      optionalText(body.notes, 500),
    )

  return { id: Number(info.lastInsertRowid), calories }
})

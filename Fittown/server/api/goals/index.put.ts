import { ACTIVITY_KEYS } from '#shared/body'

/** Numeric goal fields and their accepted ranges. */
const NUMERIC_GOALS: Record<string, { min: number; max: number }> = {
  calorie_goal: { min: 500, max: 20000 },
  protein_g: { min: 0, max: 1000 },
  carbs_g: { min: 0, max: 2000 },
  fat_g: { min: 0, max: 1000 },
  fiber_g: { min: 0, max: 300 },
  water_goal_ml: { min: 0, max: 20000 },
  height_cm: { min: 50, max: 260 },
  birth_year: { min: 1900, max: 2100 },
  goal_weight_kg: { min: 10, max: 700 },
  // Wide enough to hold anything the calculator will produce (it warns past
  // ±1 kg/week rather than refusing) while still rejecting a typo'd 50.
  goal_rate_kg_per_week: { min: -2, max: 2 },
}

const ENUM_GOALS: Record<string, string[]> = {
  weight_unit: ['kg', 'lb'],
  volume_unit: ['ml', 'floz'],
  height_unit: ['cm', 'ftin'],
  food_system: ['metric', 'imperial'],
  sex: ['male', 'female', 'unspecified'],
  activity_level: [...ACTIVITY_KEYS],
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const sets: string[] = []
  const params: unknown[] = []

  for (const [field, range] of Object.entries(NUMERIC_GOALS)) {
    if (body[field] === undefined) continue
    sets.push(`${field} = ?`)
    params.push(optionalNumber(body[field], field, range))
  }

  for (const [field, allowed] of Object.entries(ENUM_GOALS)) {
    if (body[field] === undefined) continue
    const value = body[field] === null ? null : String(body[field])
    if (value !== null && !allowed.includes(value)) {
      throw createError({
        statusCode: 400,
        statusMessage: `${field} must be one of: ${allowed.join(', ')}`,
      })
    }
    sets.push(`${field} = ?`)
    params.push(value)
  }

  if (body.exercise_adds_calories !== undefined) {
    sets.push('exercise_adds_calories = ?')
    params.push(body.exercise_adds_calories ? 1 : 0)
  }

  if (sets.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to update' })
  }

  sets.push("updated_at = datetime('now')")
  params.push(user.id)

  useDb()
    .prepare(`UPDATE user_goals SET ${sets.join(', ')} WHERE user_id = ?`)
    .run(...params)

  const goals = useDb()
    .prepare('SELECT * FROM user_goals WHERE user_id = ?')
    .get(user.id)

  return { goals }
})

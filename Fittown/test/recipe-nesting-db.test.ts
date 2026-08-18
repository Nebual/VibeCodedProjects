import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RECIPE_DEPTH, RECIPE_SOURCE, SERVING_LABEL } from '#shared/recipes'

/**
 * Recipes inside recipes, against a real SQLite file.
 *
 * Three things here are load-bearing and fail quietly: the cascade that
 * re-rolls everything built on an edited recipe, the order it does that in, and
 * the line it must not cross — a frozen meal. The cycle guard fails loudly, but
 * it fails by hanging a request, which is worse.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-nesting-test-'))
  dbPath = join(dir, 'test.db')
  process.env.FITTOWN_DB_PATH = dbPath
  vi.resetModules()
})

afterEach(() => {
  delete process.env.FITTOWN_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

async function boot() {
  vi.resetModules()
  const { useDb } = await import('../server/utils/db')
  return useDb()
}

const recipes = () => import('../server/utils/recipes')

function seed(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')").run()
  const insert = db.prepare(
    `INSERT INTO foods (source, name, brand, kcal, protein_g, carbs_g, fat_g)
     VALUES ('off', ?, 'Generic', ?, ?, ?, ?)`,
  )
  return {
    oil: Number(insert.run('Olive oil', 884, 0, 0, 100).lastInsertRowid),
    vinegar: Number(insert.run('Balsamic vinegar', 88, 0.5, 17, 0).lastInsertRowid),
    lettuce: Number(insert.run('Lettuce', 15, 1.4, 2.9, 0.2).lastInsertRowid),
  }
}

function addFood(db: DatabaseSync, recipeId: number, foodId: number, grams: number) {
  db.prepare(
    'INSERT INTO recipe_ingredients (recipe_food_id, food_id, grams) VALUES (?, ?, ?)',
  ).run(recipeId, foodId, grams)
}

/** Put `servings` of `childId` into `parentId`, the way the route does. */
function addRecipe(
  db: DatabaseSync,
  parentId: number,
  childId: number,
  count: number,
  childServingGrams: number,
) {
  db.prepare(
    `INSERT INTO recipe_ingredients
       (recipe_food_id, food_id, grams, serving_label, serving_count)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(parentId, childId, childServingGrams * count, SERVING_LABEL, count)
}

const foodRow = (db: DatabaseSync, id: number) =>
  db.prepare('SELECT * FROM foods WHERE id = ?').get(id) as Record<string, number | null>

/** A 6-serving dressing (150 g oil + 50 g vinegar) inside a salad. */
async function dressedSalad(db: DatabaseSync) {
  const { createRecipeFood, recomputeRecipeAndDependents } = await recipes()
  const ids = seed(db)

  const dressing = createRecipeFood(db, 1, 'Salad Dressing', 6)
  addFood(db, dressing, ids.oil, 150)
  addFood(db, dressing, ids.vinegar, 50)
  recomputeRecipeAndDependents(db, dressing)

  const perServing = Number(foodRow(db, dressing).serving_grams) // 200 / 6
  const salad = createRecipeFood(db, 1, 'Salad', 1)
  addFood(db, salad, ids.lettuce, 300)
  addRecipe(db, salad, dressing, 1, perServing)
  recomputeRecipeAndDependents(db, salad)

  return { ...ids, dressing, salad, perServing }
}

/** What a whole recipe comes to, in kcal. */
const recipeKcal = (db: DatabaseSync, id: number) => {
  const row = foodRow(db, id)
  return (Number(row.kcal) * Number(row.serving_grams) * Number(row.recipe_servings ?? 1)) / 100
}

describe('a recipe inside a recipe', () => {
  it('contributes exactly its share', async () => {
    const db = await boot()
    const { dressing, salad, perServing } = await dressedSalad(db)

    // 150 g oil at 884 + 50 g vinegar at 88 = 1370 kcal, over six servings.
    expect(recipeKcal(db, dressing)).toBeCloseTo(1370, 6)
    expect(perServing).toBeCloseTo(200 / 6, 6)

    // 300 g lettuce at 15 = 45 kcal, plus one serving of the dressing.
    expect(recipeKcal(db, salad)).toBeCloseTo(45 + 1370 / 6, 6)
  })

  it('follows the child when the child changes', async () => {
    const db = await boot()
    const { recomputeRecipeAndDependents } = await recipes()
    const { dressing, salad, oil } = await dressedSalad(db)

    // Another 150 g of oil: the dressing doubles in energy and grows in volume,
    // so one serving of it is both richer and heavier.
    addFood(db, dressing, oil, 150)
    recomputeRecipeAndDependents(db, dressing)

    expect(recipeKcal(db, dressing)).toBeCloseTo(1370 + 1326, 6)
    expect(recipeKcal(db, salad)).toBeCloseTo(45 + (1370 + 1326) / 6, 6)
  })

  it('re-resolves "1 serving" rather than freezing the grams it came to', async () => {
    const db = await boot()
    const { recomputeRecipeAndDependents } = await recipes()
    const { dressing, salad, oil } = await dressedSalad(db)

    const before = db
      .prepare('SELECT grams FROM recipe_ingredients WHERE recipe_food_id = ? AND food_id = ?')
      .get(salad, dressing) as { grams: number }
    expect(before.grams).toBeCloseTo(200 / 6, 6)

    addFood(db, dressing, oil, 150)
    recomputeRecipeAndDependents(db, dressing)

    const after = db
      .prepare('SELECT grams FROM recipe_ingredients WHERE recipe_food_id = ? AND food_id = ?')
      .get(salad, dressing) as { grams: number }
    // Still one serving — of a bigger batch.
    expect(after.grams).toBeCloseTo(350 / 6, 6)
  })

  it('leaves an amount entered in grams exactly as entered', async () => {
    const db = await boot()
    const { createRecipeFood, recomputeRecipeAndDependents } = await recipes()
    const { dressing, oil } = await dressedSalad(db)

    // 40 g of dressing is a weight somebody measured, not a share of a batch.
    const bowl = createRecipeFood(db, 1, 'Bowl', 1)
    db.prepare(
      'INSERT INTO recipe_ingredients (recipe_food_id, food_id, grams) VALUES (?, ?, 40)',
    ).run(bowl, dressing)
    recomputeRecipeAndDependents(db, bowl)

    addFood(db, dressing, oil, 150)
    recomputeRecipeAndDependents(db, dressing)

    const row = db
      .prepare('SELECT grams FROM recipe_ingredients WHERE recipe_food_id = ?')
      .get(bowl) as { grams: number }
    expect(row.grams).toBe(40)
  })
})

describe('the recompute cascade', () => {
  it('gets a diamond right in one pass', async () => {
    // A holds B and C; B holds C. A depth-first walk up from C can reach A
    // before B and roll A up from a stale B — and then skip A on the way back
    // because it has already been visited.
    const db = await boot()
    const { createRecipeFood, recomputeRecipeAndDependents } = await recipes()
    const ids = seed(db)

    // Created in the order C, A, B *deliberately*: A's id is lower than B's, so
    // any tie in the ordering resolves to A first. With both at the same depth —
    // which is what taking the minimum distance would give — A is rolled up
    // before the B it contains, and the wrong answer sticks. Build the diamond
    // the other way round and the bug hides behind the id order.
    const c = createRecipeFood(db, 1, 'C sauce', 1)
    const a = createRecipeFood(db, 1, 'A dish', 1)
    const b = createRecipeFood(db, 1, 'B component', 1)
    expect(a).toBeLessThan(b)

    addFood(db, c, ids.oil, 100)
    recomputeRecipeAndDependents(db, c)
    const cGrams = Number(foodRow(db, c).serving_grams)

    addRecipe(db, b, c, 1, cGrams)
    recomputeRecipeAndDependents(db, b)
    const bGrams = Number(foodRow(db, b).serving_grams)

    addRecipe(db, a, b, 1, bGrams)
    addRecipe(db, a, c, 1, cGrams)
    recomputeRecipeAndDependents(db, a)

    expect(recipeKcal(db, a)).toBeCloseTo(884 * 2, 6)

    // Double C, then cascade from it exactly once.
    addFood(db, c, ids.oil, 100)
    recomputeRecipeAndDependents(db, c)

    expect(recipeKcal(db, c)).toBeCloseTo(884 * 2, 6)
    expect(recipeKcal(db, b)).toBeCloseTo(884 * 2, 6)
    expect(recipeKcal(db, a)).toBeCloseTo(884 * 4, 6)
  })

  it('never reaches a meal already logged', async () => {
    const db = await boot()
    const { recomputeRecipeAndDependents, snapshotRecipeForLog } = await recipes()
    const { dressing, salad, oil } = await dressedSalad(db)

    const snapshot = snapshotRecipeForLog(db, salad, 1)
    const frozen = Number(foodRow(db, snapshot.id).kcal)

    // The snapshot's ingredient row still points at the live dressing, so a
    // cascade that walked into `recipe_log` rows would rewrite this meal.
    addFood(db, dressing, oil, 300)
    recomputeRecipeAndDependents(db, dressing)

    expect(Number(foodRow(db, salad).kcal)).not.toBeCloseTo(frozen, 3)
    expect(Number(foodRow(db, snapshot.id).kcal)).toBeCloseTo(frozen, 9)
  })
})

describe('refusing a cycle', () => {
  it('refuses a recipe inside itself', async () => {
    const db = await boot()
    const { nestingRefusal } = await recipes()
    const { salad } = await dressedSalad(db)

    expect(nestingRefusal(db, salad, salad)).toMatch(/itself/i)
  })

  it('refuses one that already contains the parent', async () => {
    const db = await boot()
    const { nestingRefusal } = await recipes()
    const { dressing, salad } = await dressedSalad(db)

    // The salad holds the dressing, so the dressing may not hold the salad.
    expect(nestingRefusal(db, dressing, salad)).toMatch(/Salad already contains Salad Dressing/)
    // The other way round is what already exists, and stays allowed.
    expect(nestingRefusal(db, salad, dressing)).toBeNull()
  })

  it('refuses one indirectly, two levels up', async () => {
    const db = await boot()
    const { createRecipeFood, nestingRefusal, recomputeRecipeAndDependents } = await recipes()
    const { dressing, salad } = await dressedSalad(db)

    const bowl = createRecipeFood(db, 1, 'Bowl', 1)
    addRecipe(db, bowl, salad, 1, Number(foodRow(db, salad).serving_grams))
    recomputeRecipeAndDependents(db, bowl)

    // bowl → salad → dressing, so the dressing may not hold the bowl.
    expect(nestingRefusal(db, dressing, bowl)).toMatch(/already contains/)
  })

  it('refuses a stack deeper than the limit, from either side', async () => {
    const db = await boot()
    const { createRecipeFood, nestingRefusal, recomputeRecipeAndDependents } = await recipes()
    const { dressing, salad } = await dressedSalad(db)
    expect(MAX_RECIPE_DEPTH).toBe(3)

    // salad → dressing is two levels. A third is fine…
    const bowl = createRecipeFood(db, 1, 'Bowl', 1)
    expect(nestingRefusal(db, bowl, salad)).toBeNull()
    addRecipe(db, bowl, salad, 1, Number(foodRow(db, salad).serving_grams))
    recomputeRecipeAndDependents(db, bowl)

    // …a fourth is not, and it is refused whichever side the depth comes from.
    // From below: a three-level bowl going into a fresh recipe.
    const plan = createRecipeFood(db, 1, 'Meal plan', 1)
    expect(nestingRefusal(db, plan, bowl)).toMatch(/nested 3 deep/)

    // From above: a *fresh, empty* recipe going into the dressing, which is
    // already two levels down. Neither half is too deep on its own, which is
    // exactly why both sides have to be measured.
    const empty = createRecipeFood(db, 1, 'Empty', 1)
    expect(nestingRefusal(db, dressing, empty)).toMatch(/nested 3 deep/)

    // And the same empty recipe is fine somewhere with room for it.
    expect(nestingRefusal(db, plan, empty)).toBeNull()
  })

  it('answers rather than hanging on a database that already holds a cycle', async () => {
    const db = await boot()
    const { nestingRefusal } = await recipes()
    const { dressing, salad } = await dressedSalad(db)

    // Forced in behind the guard's back, which is the only way it can happen.
    db.prepare(
      'INSERT INTO recipe_ingredients (recipe_food_id, food_id, grams) VALUES (?, ?, 10)',
    ).run(dressing, salad)

    expect(nestingRefusal(db, salad, dressing)).toMatch(/already contains/)
  })
})

describe('housekeeping', () => {
  it('orders recipes children-first for the maintenance scripts', async () => {
    const db = await boot()
    const { recipesInDependencyOrder } = await recipes()
    const { dressing, salad } = await dressedSalad(db)

    const order = recipesInDependencyOrder(db).map((r) => r.id)
    expect(order.indexOf(dressing)).toBeLessThan(order.indexOf(salad))
    // And a frozen meal is not in the list at all.
    const { snapshotRecipeForLog } = await recipes()
    const snapshot = snapshotRecipeForLog(db, salad, 1)
    expect(recipesInDependencyOrder(db).map((r) => r.id)).not.toContain(snapshot.id)
  })

  it('copies a nested recipe across as a recipe, once', async () => {
    const db = await boot()
    const { copyRecipeInto } = await recipes()
    const { salad, dressing } = await dressedSalad(db)
    db.prepare("INSERT INTO users (id, email, name) VALUES (2, 'friend@test', 'Friend')").run()

    const copy = copyRecipeInto(db, salad, 2)

    const nested = db
      .prepare(
        `SELECT f.id, f.source, f.owner_user_id, f.name
         FROM recipe_ingredients ri JOIN foods f ON f.id = ri.food_id
         WHERE ri.recipe_food_id = ? AND f.source = ?`,
      )
      .all(copy, RECIPE_SOURCE) as { id: number; owner_user_id: number; name: string }[]

    expect(nested).toHaveLength(1)
    // Their own copy of the dressing, not a pointer at yours, and not flattened
    // into a plain food that has the right calories and no ingredients.
    expect(nested[0]!.id).not.toBe(dressing)
    expect(nested[0]!.owner_user_id).toBe(2)
    const lines = db
      .prepare('SELECT COUNT(*) AS c FROM recipe_ingredients WHERE recipe_food_id = ?')
      .get(nested[0]!.id) as { c: number }
    expect(lines.c).toBe(2)

    // Same arithmetic on both sides of the copy.
    expect(recipeKcal(db, copy)).toBeCloseTo(recipeKcal(db, salad), 6)
  })
})

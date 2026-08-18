import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Drinks logged in the food diary should count toward the day's water goal
 * automatically. These tests are the guarantee that the category-keyword
 * match in server/utils/hydration.ts stays conservative: real beverages earn
 * credit, but non-drink liquids (oil, cooking wine, cream) and alcohol don't
 * quietly inflate the goal.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-hydration-test-'))
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

function seedFood(
  db: DatabaseSync,
  opts: {
    name: string
    categories: string | null
    is_liquid: 0 | 1
    water_g?: number | null
    alcohol_g?: number | null
  },
) {
  const info = db
    .prepare(
      `INSERT INTO foods (source, name, categories, is_liquid, water_g, alcohol_g)
       VALUES ('off', ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.name,
      opts.categories,
      opts.is_liquid,
      opts.water_g ?? null,
      opts.alcohol_g ?? null,
    )
  return Number(info.lastInsertRowid)
}

function logEntry(db: DatabaseSync, foodId: number, grams: number) {
  db.prepare(
    `INSERT INTO diary_entries (user_id, date, meal, food_id, grams)
     VALUES (1, '2026-08-18', 'breakfast', ?, ?)`,
  ).run(foodId, grams)
}

async function totalHydrationMl(db: DatabaseSync) {
  const { HYDRATION_ML_SQL } = await import('../server/utils/hydration')
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${HYDRATION_ML_SQL}), 0) AS ml
       FROM diary_entries d JOIN foods f ON f.id = d.food_id
       WHERE d.user_id = 1 AND d.date = '2026-08-18'`,
    )
    .get() as { ml: number }
  return row.ml
}

describe('hydration credit', () => {
  it('uses measured water_g when present', async () => {
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@test', 'A')").run()
    const milk = seedFood(db, {
      name: 'Whole milk',
      categories: 'Dairies,Milks,Whole milks',
      is_liquid: 1,
      water_g: 88,
    })
    logEntry(db, milk, 250) // 250ml glass of milk
    expect(await totalHydrationMl(db)).toBeCloseTo(220, 5) // 250 * 0.88
  })

  it('credits USDA Foundation Foods milk, filed under "Dairy and Egg Products"', async () => {
    // Regression: Foundation Foods uses USDA's old food-group taxonomy, not
    // OFF/Branded-style categories, so fluid milk doesn't say "Milk" or
    // "Beverages" — it says "Dairy and Egg Products", same as cheese and eggs.
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@test', 'A')").run()
    const milk = seedFood(db, {
      name: 'Milk, whole, 3.25% milkfat, with added vitamin D',
      categories: 'Dairy and Egg Products',
      is_liquid: 1,
      water_g: 88.1,
    })
    logEntry(db, milk, 240)
    expect(await totalHydrationMl(db)).toBeCloseTo(240 * 0.881, 5)
  })

  it('does not credit solid "Dairy and Egg Products" foods (cheese, eggs)', async () => {
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@test', 'A')").run()
    const cheese = seedFood(db, {
      name: 'Cheese, cheddar', categories: 'Dairy and Egg Products', is_liquid: 0,
    })
    logEntry(db, cheese, 50)
    expect(await totalHydrationMl(db)).toBe(0)
  })

  it('defaults non-alcoholic drinks to 90% when water_g is absent', async () => {
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@test', 'A')").run()
    const juice = seedFood(db, {
      name: 'Orange juice',
      categories: 'Beverages,Plant-based beverages,Juices and nectars,Fruit juices,Orange juices',
      is_liquid: 1,
      water_g: null,
    })
    logEntry(db, juice, 200)
    expect(await totalHydrationMl(db)).toBeCloseTo(180, 5) // 200 * 0.90 default
  })

  it('gives zero credit to alcoholic drinks even if the category matches', async () => {
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@test', 'A')").run()
    const beer = seedFood(db, {
      name: 'Lager',
      categories: 'Beverages,Alcoholic beverages,Beers',
      is_liquid: 1,
      water_g: 92,
      alcohol_g: 4,
    })
    logEntry(db, beer, 330)
    expect(await totalHydrationMl(db)).toBe(0)
  })

  it('gives zero credit to non-drink liquids (oil, cooking wine, cream)', async () => {
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@test', 'A')").run()
    const oil = seedFood(db, {
      name: 'Olive oil', categories: 'Fats,Vegetable oils', is_liquid: 1, water_g: 0,
    })
    const cookingWine = seedFood(db, {
      name: 'Cooking wine', categories: 'Vinegars/Cooking Wines', is_liquid: 1,
    })
    const cream = seedFood(db, {
      name: 'Heavy cream', categories: 'Cream/Cream Substitutes', is_liquid: 1, water_g: 58,
    })
    logEntry(db, oil, 15)
    logEntry(db, cookingWine, 30)
    logEntry(db, cream, 50)
    expect(await totalHydrationMl(db)).toBe(0)
  })

  it('gives zero credit to solid foods regardless of category text', async () => {
    const db = await boot()
    db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'a@test', 'A')").run()
    const soup = seedFood(db, {
      name: 'Canned soup', categories: 'Soups,Meals', is_liquid: 0, water_g: 90,
    })
    logEntry(db, soup, 300)
    expect(await totalHydrationMl(db)).toBe(0)
  })
})

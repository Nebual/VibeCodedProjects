import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NUTRIENT_KEYS } from '#shared/nutrients'

/**
 * Friendship storage, the access gate, and the recipe copy — against a real
 * SQLite file, in the style of `db-schema.test.ts`.
 *
 * These are the parts where a mistake is expensive rather than annoying: a
 * missed check hands somebody a health diary, and a shallow copy leaves two
 * households sharing one editable row.
 */

let dir: string
let dbPath: string

/**
 * Nitro auto-imports `createError`; Vitest doesn't run through Nitro.
 *
 * `server/utils/recipes.ts` avoids the problem by never throwing HTTP errors,
 * but the whole job of `requireFriendship()` is to throw the right one, and it
 * is much too important to leave untested. The shim matches h3's shape closely
 * enough for the assertions below.
 */
function installCreateError() {
  ;(globalThis as Record<string, unknown>).createError = (input: {
    statusCode: number
    statusMessage: string
  }) => Object.assign(new Error(input.statusMessage), input)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-friends-'))
  dbPath = join(dir, 'test.db')
  process.env.FITTOWN_DB_PATH = dbPath
  installCreateError()
  vi.resetModules()
})

afterEach(() => {
  delete process.env.FITTOWN_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

async function boot() {
  vi.resetModules()
  installCreateError()
  const { useDb } = await import('../server/utils/db')
  return useDb()
}

const friends = () => import('../server/utils/friends')
const recipes = () => import('../server/utils/recipes')

function inspect() {
  return new DatabaseSync(dbPath, { readOnly: true })
}

/** Three people, so "a stranger" is always available. */
function seedUsers(db: DatabaseSync) {
  for (const [id, email, name] of [
    [1, 'alice@x.test', 'Alice'],
    [2, 'bob@x.test', 'Bob'],
    [3, 'carol@x.test', ''],
  ] as const) {
    db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id, email, name)
    db.prepare('INSERT INTO user_goals (user_id) VALUES (?)').run(id)
  }
}

describe('schema', () => {
  it('creates the sharing tables on a fresh database', async () => {
    await boot()
    const tables = (
      inspect().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)

    for (const table of ['friendships', 'friend_invites', 'recipe_shares']) {
      expect(tables, `missing table ${table}`).toContain(table)
    }
  })

  it('adds the sharing switches to an existing user_goals row', async () => {
    // The shape as it shipped before friends existed.
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_sub TEXT UNIQUE,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE user_goals (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        calorie_goal REAL NOT NULL DEFAULT 2000,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (id, email, name) VALUES (1, 'old@user.test', 'Old User');
      INSERT INTO user_goals (user_id, calorie_goal) VALUES (1, 2400);
    `)
    legacy.close()

    await boot()

    const row = inspect()
      .prepare('SELECT * FROM user_goals WHERE user_id = 1')
      .get() as Record<string, unknown>

    // Existing settings survive, and the switches arrive switched on.
    expect(row.calorie_goal).toBe(2400)
    for (const key of [
      'share_recipes', 'share_diary', 'share_weight', 'share_calories', 'share_exercise',
      'share_custom_foods',
    ]) {
      expect(row[key], `migration missed ${key}`).toBe(1)
    }
  })

  it('refuses a second row for the same pair, in either direction', async () => {
    const db = await boot()
    seedUsers(db)

    db.prepare('INSERT INTO friendships (requester_id, addressee_id) VALUES (1, 2)').run()

    // Without the unordered index, two people inviting each other at the same
    // moment get two rows — and accepting one leaves the other pending for ever.
    expect(() =>
      db.prepare('INSERT INTO friendships (requester_id, addressee_id) VALUES (2, 1)').run(),
    ).toThrow(/UNIQUE/)

    // A different pair is still fine.
    expect(() =>
      db.prepare('INSERT INTO friendships (requester_id, addressee_id) VALUES (1, 3)').run(),
    ).not.toThrow()
  })

  it('refuses a friendship with yourself', async () => {
    const db = await boot()
    seedUsers(db)
    expect(() =>
      db.prepare('INSERT INTO friendships (requester_id, addressee_id) VALUES (1, 1)').run(),
    ).toThrow(/CHECK/)
  })

  it('allows one live share link per recipe and any number of dead ones', async () => {
    const db = await boot()
    seedUsers(db)
    db.prepare("INSERT INTO foods (id, source, name, owner_user_id) VALUES (7, 'recipe', 'R', 1)").run()

    db.prepare("INSERT INTO recipe_shares (token, food_id, owner_user_id) VALUES ('a', 7, 1)").run()
    expect(() =>
      db.prepare("INSERT INTO recipe_shares (token, food_id, owner_user_id) VALUES ('b', 7, 1)").run(),
    ).toThrow(/UNIQUE/)

    db.prepare("UPDATE recipe_shares SET revoked_at = datetime('now') WHERE token = 'a'").run()
    expect(() =>
      db.prepare("INSERT INTO recipe_shares (token, food_id, owner_user_id) VALUES ('b', 7, 1)").run(),
    ).not.toThrow()
  })
})

describe('requesting and answering', () => {
  it('starts pending and shows up on both sides', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    expect(f.requestFriendship(db, 1, 2)).toEqual({ status: 'pending' })
    expect(f.listOutgoing(db, 1).map((p) => p.id)).toEqual([2])
    expect(f.listIncoming(db, 2).map((p) => p.id)).toEqual([1])
    expect(f.areFriends(db, 1, 2)).toBe(false)
  })

  it('asking twice is not an error and does not duplicate the row', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.requestFriendship(db, 1, 2)
    expect(f.requestFriendship(db, 1, 2)).toEqual({ status: 'pending' })
    expect(f.listIncoming(db, 2)).toHaveLength(1)
  })

  it('treats asking someone who already asked you as a yes', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.requestFriendship(db, 1, 2)
    expect(f.requestFriendship(db, 2, 1)).toEqual({ status: 'accepted' })
    expect(f.areFriends(db, 1, 2)).toBe(true)
    expect(f.listIncoming(db, 2)).toHaveLength(0)
  })

  it('only the addressee can accept', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.requestFriendship(db, 1, 2)
    const id = f.listIncoming(db, 2)[0]!.friendship_id

    // The requester accepting their own request would be a way to befriend
    // anyone at all; a bystander's guess must do nothing either.
    expect(f.acceptFriendship(db, id, 1)).toBe(false)
    expect(f.acceptFriendship(db, id, 3)).toBe(false)
    expect(f.areFriends(db, 1, 2)).toBe(false)

    expect(f.acceptFriendship(db, id, 2)).toBe(true)
    expect(f.areFriends(db, 1, 2)).toBe(true)
  })

  it('either side can end it, and they can start over afterwards', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.requestFriendship(db, 1, 2)
    const id = f.listIncoming(db, 2)[0]!.friendship_id
    f.acceptFriendship(db, id, 2)

    expect(f.removeFriendship(db, id, 3)).toBe(false)
    expect(f.removeFriendship(db, id, 2)).toBe(true)
    expect(f.areFriends(db, 1, 2)).toBe(false)

    expect(() => f.requestFriendship(db, 1, 2)).not.toThrow()
  })

  it('an invite link makes friends outright, with nothing left pending', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.establishFriendship(db, 1, 2)
    expect(f.areFriends(db, 1, 2)).toBe(true)
    expect(f.listIncoming(db, 2)).toHaveLength(0)
    expect(f.listOutgoing(db, 1)).toHaveLength(0)

    // And it upgrades a request that was already out rather than colliding.
    f.requestFriendship(db, 1, 3)
    f.establishFriendship(db, 3, 1)
    expect(f.areFriends(db, 1, 3)).toBe(true)
  })

  it('lists friends whichever way round the request went', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.establishFriendship(db, 1, 2)
    f.establishFriendship(db, 3, 1)

    expect(f.friendIds(db, 1).sort()).toEqual([2, 3])
    expect(f.listFriends(db, 1).map((x) => x.id).sort()).toEqual([2, 3])
    // A user with no name still sorts and displays by something.
    expect(f.listFriends(db, 3)[0]!.id).toBe(1)
  })
})

describe('invite links', () => {
  it('stays listed as live after being taken up, so a second person can still use it', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    db.prepare(
      `INSERT INTO friend_invites (token, inviter_id, expires_at)
       VALUES ('tok1', 1, datetime('now', '+30 days'))`,
    ).run()

    const liveInvites = () =>
      db
        .prepare(
          `SELECT token FROM friend_invites
           WHERE inviter_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
        )
        .all(1)

    // Bob takes up the link — the row backing it is untouched, so it's still
    // live for whoever opens it next.
    f.establishFriendship(db, 1, 2)
    expect(liveInvites()).toHaveLength(1)

    // Carol uses the very same token and becomes a friend too.
    f.establishFriendship(db, 1, 3)
    expect(f.areFriends(db, 1, 2)).toBe(true)
    expect(f.areFriends(db, 1, 3)).toBe(true)
    expect(liveInvites()).toHaveLength(1)
  })
})

describe('the access gate', () => {
  it('refuses a stranger with a 404 rather than confirming they exist', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    expect(() => f.requireFriendship(db, 1, 2)).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    )
    // A pending request is not consent.
    f.requestFriendship(db, 1, 2)
    expect(() => f.requireFriendship(db, 1, 2)).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    )
  })

  it('lets an accepted friend through', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.establishFriendship(db, 1, 2)
    expect(f.requireFriendship(db, 1, 2).email).toBe('bob@x.test')
  })

  it('never leaks the google subject id', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.establishFriendship(db, 1, 2)
    expect(Object.keys(f.requireFriendship(db, 1, 2)).sort()).toEqual([
      'avatar_url', 'email', 'id', 'name',
    ])
  })

  it('403s per section when a friend has switched one off', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.establishFriendship(db, 1, 2)
    expect(() => f.requireSharedSection(db, 1, 2, 'share_recipes')).not.toThrow()

    db.prepare('UPDATE user_goals SET share_recipes = 0 WHERE user_id = 2').run()
    expect(() => f.requireSharedSection(db, 1, 2, 'share_recipes')).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    )
    // The other four are unaffected.
    expect(() => f.requireSharedSection(db, 1, 2, 'share_weight')).not.toThrow()
  })

  it('a stranger is still a 404 even when everything is shared', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    expect(() => f.requireSharedSection(db, 1, 2, 'share_recipes')).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    )
  })

  it('treats a user with no goals row as sharing everything', async () => {
    const db = await boot()
    seedUsers(db)
    db.prepare('DELETE FROM user_goals WHERE user_id = 2').run()
    const f = await friends()

    expect(f.friendPermissions(db, 2).share_recipes).toBe(true)
  })
})

// ---------------------------------------------------------------------------

/** An OFF product: shared, referenced by copies rather than duplicated. */
function seedOffFood(db: DatabaseSync, name: string, kcal: number) {
  const info = db
    .prepare(
      `INSERT INTO foods (source, barcode, name, kcal, protein_g, carbs_g, fat_g)
       VALUES ('off', ?, ?, ?, 10, 20, 5)`,
    )
    .run(`bc-${name}`, name, kcal)
  return Number(info.lastInsertRowid)
}

/** Somebody's private custom food, complete with the barcode that traps a copy. */
function seedCustomFood(db: DatabaseSync, owner: number, name: string, kcal: number) {
  const info = db
    .prepare(
      `INSERT INTO foods (source, barcode, name, brand, kcal, protein_g, carbs_g, fat_g, owner_user_id)
       VALUES ('custom', ?, ?, 'Homemade', ?, 8, 15, 3, ?)`,
    )
    // The barcode includes the owner because `(source, barcode)` is unique —
    // the same constraint that stops a copy carrying the barcode across.
    .run(`custom-${owner}-${name}`, name, kcal, owner)
  return Number(info.lastInsertRowid)
}

async function seedRecipe(db: DatabaseSync, owner: number, name: string, parts: [number, number][]) {
  const r = await recipes()
  const id = r.createRecipeFood(db, owner, name, 4)
  let order = 0
  for (const [foodId, grams] of parts) {
    db.prepare(
      `INSERT INTO recipe_ingredients (recipe_food_id, food_id, grams, sort_order)
       VALUES (?, ?, ?, ?)`,
    ).run(id, foodId, grams, order++)
  }
  r.recomputeRecipe(db, id)
  return id
}

describe('copying a recipe', () => {
  it('reproduces the ingredients and the numbers', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const beans = seedOffFood(db, 'Beans', 120)
    const rice = seedOffFood(db, 'Rice', 350)
    const source = await seedRecipe(db, 2, 'Chili', [[beans, 400], [rice, 200]])

    const before = r.recipeDetail(db, source, 2)!
    const copyId = r.copyRecipeInto(db, source, 1)
    const after = r.recipeDetail(db, copyId, 1)!

    expect(after.ingredients.map((i) => i.grams)).toEqual([400, 200])
    expect(after.per_serving.kcal).toBeCloseTo(before.per_serving.kcal!, 6)
    expect(after.raw_g).toBe(before.raw_g)
    for (const key of NUTRIENT_KEYS) {
      expect(after.totals[key] ?? null).toEqual(before.totals[key] ?? null)
    }
  })

  it('hands the copy to the copier, and leaves the original alone', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const beans = seedOffFood(db, 'Beans', 120)
    const source = await seedRecipe(db, 2, 'Chili', [[beans, 400]])
    const copyId = r.copyRecipeInto(db, source, 1)

    expect(r.findRecipe(db, copyId, 1)).toBeDefined()
    expect(r.findRecipe(db, copyId, 2)).toBeUndefined()
    // Editing the copy must not reach back into theirs.
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_food_id = ?').run(copyId)
    r.recomputeRecipe(db, copyId)
    expect(r.recipeDetail(db, source, 2)!.ingredients).toHaveLength(1)
  })

  it('names the copy so it can be told apart in a list', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const beans = seedOffFood(db, 'Beans', 120)
    const source = await seedRecipe(db, 2, 'Chili', [[beans, 400]])

    const first = r.copyRecipeInto(db, source, 1)
    const second = r.copyRecipeInto(db, source, 1)
    const name = (id: number) =>
      (db.prepare('SELECT name FROM foods WHERE id = ?').get(id) as { name: string }).name

    expect(name(first)).toBe('Chili')
    expect(name(second)).toBe('Chili (copy)')
  })

  it('is searchable straight away', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const beans = seedOffFood(db, 'Beans', 120)
    const source = await seedRecipe(db, 2, 'Borscht', [[beans, 400]])
    const copyId = r.copyRecipeInto(db, source, 1)

    // foods_fts is external-content and maintained by hand; a path that
    // creates a food and forgets to index it produces a food nobody can find.
    const hits = db
      .prepare("SELECT rowid FROM foods_fts WHERE foods_fts MATCH 'Borscht'")
      .all() as { rowid: number }[]
    expect(hits.map((h) => h.rowid)).toContain(copyId)
  })

  it('deep-copies an ingredient that belongs to the other person', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const beans = seedOffFood(db, 'Beans', 120)
    const sourdough = seedCustomFood(db, 2, 'Mums Sourdough', 260)
    const source = await seedRecipe(db, 2, 'Chili', [[beans, 400], [sourdough, 100]])

    const copyId = r.copyRecipeInto(db, source, 1)
    const ingredients = db
      .prepare(
        `SELECT f.id, f.name, f.owner_user_id, f.source, f.barcode, f.kcal
         FROM recipe_ingredients ri JOIN foods f ON f.id = ri.food_id
         WHERE ri.recipe_food_id = ? ORDER BY ri.sort_order`,
      )
      .all(copyId) as {
        id: number
        name: string
        owner_user_id: number | null
        source: string
        barcode: string | null
        kcal: number
      }[]

    // The shared OFF row is referenced as-is...
    expect(ingredients[0]!.id).toBe(beans)
    // ...while their private food becomes one of yours, with its numbers.
    expect(ingredients[1]!.id).not.toBe(sourdough)
    expect(ingredients[1]!.owner_user_id).toBe(1)
    expect(ingredients[1]!.name).toBe('Mums Sourdough')
    expect(ingredients[1]!.kcal).toBe(260)
    // The barcode has to go: (source, barcode) is unique, so carrying it over
    // would collide with the row being copied.
    expect(ingredients[1]!.barcode).toBeNull()
  })

  it('does not pile up duplicates of the same borrowed food', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const sourdough = seedCustomFood(db, 2, 'Mums Sourdough', 260)
    const one = await seedRecipe(db, 2, 'Toast', [[sourdough, 100]])
    const two = await seedRecipe(db, 2, 'Sandwich', [[sourdough, 200]])

    r.copyRecipeInto(db, one, 1)
    r.copyRecipeInto(db, two, 1)

    const mine = db
      .prepare(
        "SELECT COUNT(*) AS c FROM foods WHERE owner_user_id = 1 AND source = 'custom' AND name = 'Mums Sourdough'",
      )
      .get() as { c: number }
    expect(mine.c).toBe(1)
  })

  it('keeps a borrowed food that only looks similar separate', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const theirs = seedCustomFood(db, 2, 'Mums Sourdough', 260)
    const different = seedCustomFood(db, 3, 'Mums Sourdough', 310)
    const one = await seedRecipe(db, 2, 'Toast', [[theirs, 100]])
    const two = await seedRecipe(db, 3, 'Toastie', [[different, 100]])

    r.copyRecipeInto(db, one, 1)
    r.copyRecipeInto(db, two, 1)

    const mine = db
      .prepare(
        "SELECT kcal FROM foods WHERE owner_user_id = 1 AND source = 'custom' ORDER BY kcal",
      )
      .all() as { kcal: number }[]
    // Same name, different food: merging them would silently restate one
    // person's bread as another's.
    expect(mine.map((f) => f.kcal)).toEqual([260, 310])
  })

  it('carries the yield and the liquid flag, so portions still make sense', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const stock = seedOffFood(db, 'Stock', 30)
    const source = await seedRecipe(db, 2, 'Soup', [[stock, 900]])
    db.prepare(
      'UPDATE foods SET is_liquid = 1, recipe_final_weight_g = 800 WHERE id = ?',
    ).run(source)
    r.recomputeRecipe(db, source)

    const copyId = r.copyRecipeInto(db, source, 1)
    const copy = db
      .prepare('SELECT is_liquid, recipe_final_weight_g, recipe_servings, serving_grams FROM foods WHERE id = ?')
      .get(copyId) as Record<string, number>

    expect(copy.is_liquid).toBe(1)
    expect(copy.recipe_final_weight_g).toBe(800)
    expect(copy.recipe_servings).toBe(4)
    expect(copy.serving_grams).toBe(200)
  })

  it('copies an empty recipe without inventing a serving for it', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const source = await seedRecipe(db, 2, 'Nothing Yet', [])
    const copyId = r.copyRecipeInto(db, source, 1)
    const copy = db
      .prepare('SELECT serving_grams, kcal FROM foods WHERE id = ?')
      .get(copyId) as { serving_grams: number | null; kcal: number | null }

    // Null, not zero: nothing has been decided about this recipe yet, and a
    // serving size with no nutrition under it is a portion the diary would log.
    expect(copy.serving_grams).toBeNull()
    expect(copy.kcal).toBeNull()
  })
})

describe('sharing custom foods', () => {
  it('lets an accepted friend in when the toggle is on, and bars everyone else', async () => {
    const db = await boot()
    seedUsers(db)
    const f = await friends()

    f.establishFriendship(db, 1, 2)

    // Friends who share: in.
    expect(f.friendSharesCustomFoods(db, 1, 2)).toBe(true)
    // Your own foods are always yours.
    expect(f.friendSharesCustomFoods(db, 1, 1)).toBe(true)
    // A stranger (Carol has no friendship with Alice): out, even though the
    // toggle is on by default — friendship is the hard gate.
    expect(f.friendSharesCustomFoods(db, 1, 3)).toBe(false)

    // A friend who turned it off: out.
    db.prepare('UPDATE user_goals SET share_custom_foods = 0 WHERE user_id = 2').run()
    expect(f.friendSharesCustomFoods(db, 1, 2)).toBe(false)

    // The other toggles are independent — recipes still flow.
    expect(f.requireSharedSection(db, 1, 2, 'share_recipes')).toBeDefined()
  })

  it('lists only a user’s own custom foods', async () => {
    const db = await boot()
    seedUsers(db)
    const { listCustomFoods } = await import('../server/utils/foods')

    const theirs = seedCustomFood(db, 2, 'Mums Sourdough', 260)
    const pickles = seedCustomFood(db, 2, 'Pickles', 20)
    // A custom food with no energy recorded, so the list must be able to tell
    // "not recorded" (null) apart from zero.
    const gizmoId = Number(
      db
        .prepare(
          "INSERT INTO foods (source, owner_user_id, name, brand, kcal) VALUES ('custom', 2, 'Gizmo', 'Homemade', NULL)",
        )
        .run().lastInsertRowid,
    )
    // Carol's food must not appear in Bob's list.
    seedCustomFood(db, 3, 'Carol Chili', 180)

    const rows = listCustomFoods(db, 2)
    expect(rows.map((r) => Number(r.id)).sort()).toEqual([theirs, pickles, gizmoId].sort())
    // The bread carries its numbers for the browse row.
    const bread = rows.find((r) => r.id === theirs)!
    expect(bread.name).toBe('Mums Sourdough')
    expect(bread.kcal).toBe(260)
    // Null stays null on the way to the UI — never coerced to a fake 0.
    const gizmo = rows.find((r) => r.name === 'Gizmo')!
    expect(gizmo.kcal).toBeNull()
  })

  it('copies a friend’s custom food into your own library, indexed and idempotent', async () => {
    const db = await boot()
    seedUsers(db)
    const r = await recipes()

    const source = seedCustomFood(db, 2, 'Mums Sourdough', 260)
    const first = r.copyCustomFoodInto(db, source, 1)
    // Copying it again returns the same copy rather than piling up duplicates.
    const again = r.copyCustomFoodInto(db, source, 1)
    expect(again).toBe(first)

    const copy = db
      .prepare('SELECT id, name, owner_user_id, source, kcal, barcode FROM foods WHERE id = ?')
      .get(first) as {
        id: number
        name: string
        owner_user_id: number
        source: string
        kcal: number
        barcode: string | null
      }
    expect(copy.name).toBe('Mums Sourdough')
    expect(copy.owner_user_id).toBe(1)
    expect(copy.source).toBe('custom')
    expect(copy.kcal).toBe(260)
    // (source, barcode) is unique, so the barcode has to stay behind.
    expect(copy.barcode).toBeNull()

    // It is immediately searchable — a path that creates a food and forgets to
    // index it produces one nobody can find.
    const hits = db
      .prepare("SELECT rowid FROM foods_fts WHERE foods_fts MATCH 'Sourdough'")
      .all() as { rowid: number }[]
    expect(hits.map((h) => h.rowid)).toContain(first)

    // Exactly one copy in Alice's library, none elsewhere.
    const count = (owner: number) =>
      (db
        .prepare(
          "SELECT COUNT(*) AS c FROM foods WHERE owner_user_id = ? AND source = 'custom' AND name = 'Mums Sourdough'",
        )
        .get(owner) as { c: number }).c
    expect(count(1)).toBe(1)
    expect(count(2)).toBe(1) // the original is untouched
    expect(count(3)).toBe(0)
  })
})

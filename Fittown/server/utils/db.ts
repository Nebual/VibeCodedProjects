import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
// Explicit extension: the maintenance scripts in `scripts/` import this module
// under plain `node`, which resolves ESM specifiers literally. Same reason
// `server/utils/recipes.ts` writes `./foods.ts`.
import { POST_MIGRATION_SQL, SCHEMA_SQL } from '../db/schema.ts'
import { ACTIVITIES, metColumns } from '#shared/activities'

let db: DatabaseSync | null = null

/**
 * Resolve the database file location.
 *
 * Defaults to `<project>/data/fittown.db` so a fresh checkout just works, but
 * deployments should set FITTOWN_DB_PATH to somewhere outside the app
 * directory (e.g. /var/lib/fittown/fittown.db) so upgrades never touch data.
 */
function dbPath(): string {
  const configured = process.env.FITTOWN_DB_PATH
  return configured
    ? resolve(configured)
    : resolve(process.cwd(), 'data/fittown.db')
}

/**
 * Open (once) and return the shared connection.
 *
 * node:sqlite is synchronous, which is fine here: SQLite reads are served from
 * page cache in microseconds, and this app's write volume is a handful of rows
 * per meal. WAL mode keeps readers from blocking the writer.
 */
export function useDb(): DatabaseSync {
  if (db) return db

  const path = dbPath()
  mkdirSync(dirname(path), { recursive: true })

  db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  // Wait rather than immediately throwing SQLITE_BUSY if another process
  // (notably the OFF importer) holds the write lock.
  db.exec('PRAGMA busy_timeout = 10000')
  db.exec('PRAGMA synchronous = NORMAL')

  // Deliberately before `PRAGMA foreign_keys = ON`: this brings the schema up to
  // date, and one part of that rebuilds a table — the pragma cannot be changed
  // inside a transaction. SQLite's default is off, and nothing in here relies on
  // enforcement, so the window is inert for everything except the rebuild.
  ensureSchema(db)
  db.exec('PRAGMA foreign_keys = ON')

  syncExerciseLibrary(db)

  return db
}

/**
 * Bring a database's shape up to date. Idempotent, and safe on a fresh file.
 *
 * Split out of `useDb()` so the maintenance scripts in `scripts/` can apply the
 * same migration to a database they opened themselves. They can't call
 * `useDb()` — it owns a singleton connection pointed at `FITTOWN_DB_PATH`, and
 * a script takes its path as an argument — but they must not skip this either:
 * a script that reads a column `ADDED_COLUMNS` hasn't added yet fails halfway
 * through with a bare "no such column".
 *
 * **Call before `PRAGMA foreign_keys = ON`.** `rebuildRecipeIngredients()`
 * cannot run with enforcement on.
 *
 * Returns the columns it added, for callers that want to say what changed.
 */
export function ensureSchema(conn: DatabaseSync): Set<string> {
  conn.exec(SCHEMA_SQL)
  rebuildRecipeIngredients(conn)
  const added = migrate(conn)
  // Indexes over columns migrate() may only just have added — see the comment
  // on POST_MIGRATION_SQL. Running these inside SCHEMA_SQL would fail the boot
  // of every database that predates the column.
  conn.exec(POST_MIGRATION_SQL)

  // Only when the column is new. Scoped to recipes, but an unconditional
  // version would still scan 200k+ food rows on every boot to find nothing.
  if (added.has('foods.recipe_family_id')) {
    conn.prepare(
      "UPDATE foods SET recipe_family_id = id WHERE source = 'recipe' AND recipe_family_id IS NULL",
    ).run()
  }

  return added
}

/**
 * Columns added to a table after it first shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * SCHEMA_SQL alone never widens an existing database — a returning user would
 * get "no such column" on boot. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * hence the table_info check below.
 *
 * Entries stay here permanently: they are how an old database catches up, and
 * they are cheap (one PRAGMA per table per boot). Anything added here must
 * also be added to SCHEMA_SQL, which is what a fresh database uses.
 */
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  user_goals: {
    sex: 'TEXT',
    birth_year: 'INTEGER',
    height_cm: 'REAL',
    height_unit: "TEXT NOT NULL DEFAULT 'cm'",
    food_system: "TEXT NOT NULL DEFAULT 'metric'",
    activity_level: 'TEXT',
    goal_weight_kg: 'REAL',
    goal_rate_kg_per_week: 'REAL',
    // Per-category sharing with friends. Default 1 so an existing household
    // that adds friends after upgrading behaves the same as a new one.
    share_recipes: 'INTEGER NOT NULL DEFAULT 1',
    share_diary: 'INTEGER NOT NULL DEFAULT 1',
    share_weight: 'INTEGER NOT NULL DEFAULT 1',
    share_calories: 'INTEGER NOT NULL DEFAULT 1',
    share_exercise: 'INTEGER NOT NULL DEFAULT 1',
    share_custom_foods: 'INTEGER NOT NULL DEFAULT 1',
  },
  exercises: {
    met_light: 'REAL',
    met_hard: 'REAL',
    tracks_sets: 'INTEGER NOT NULL DEFAULT 0',
    tracks_distance: 'INTEGER NOT NULL DEFAULT 0',
    hint: 'TEXT',
  },
  workout_entries: {
    effort: 'TEXT',
  },
  // Recipes. Null on the 200k+ imported rows, which costs a byte each in the
  // record header and saves a second table to join on every food query.
  foods: {
    recipe_servings: 'REAL',
    recipe_final_weight_g: 'REAL',
    recipe_instructions: 'TEXT',
    sugar_alcohols_g: 'REAL',
    // Frozen copies of a recipe, made when it is logged. A foreign key is
    // legal on ADD COLUMN as long as the default is NULL, which it is.
    logged_from_food_id: 'INTEGER REFERENCES foods(id) ON DELETE SET NULL',
    recipe_log_note: 'TEXT',
    // Backfilled to the row's own id for existing recipes in useDb(), once.
    recipe_family_id: 'INTEGER',
    // Whoever flagged this food as inaccurate. Null = never reported. The
    // page uses it to hide the food and to offer the reporter an Undo. FK is
    // legal on ADD COLUMN as long as the default is NULL, which it is.
    reported_by: 'INTEGER REFERENCES users(id) ON DELETE SET NULL',
  },
  // Also created by rebuildRecipeIngredients() below, which ships the whole new
  // shape at once. Listed here anyway: the rebuild is guarded on food_id's
  // nullability, so a database that somehow has one change without the other
  // still catches up, and this is where a reader looks for the column list.
  recipe_ingredients: {
    raw_text: 'TEXT',
    note: 'TEXT',
    // Optional ingredients. Defaults reproduce the old behaviour exactly, so
    // every existing row keeps counting the way it always did.
    is_optional: 'INTEGER NOT NULL DEFAULT 0',
    is_included: 'INTEGER NOT NULL DEFAULT 1',
  },
}

/**
 * Make `recipe_ingredients.food_id` nullable on a database that predates the
 * recipe importer.
 *
 * SQLite has no `ALTER COLUMN`, so dropping a NOT NULL means the documented
 * rebuild: create the new shape, copy the rows, drop, rename, recreate the
 * indexes. `ADDED_COLUMNS` cannot express this, which makes it the one schema
 * change in this app that isn't a two-line edit.
 *
 * Guarded on the thing it fixes rather than on a version number, so it is a
 * no-op on every boot after the first and on every fresh database (where
 * SCHEMA_SQL already created the new shape).
 *
 * Must run with foreign key enforcement OFF — see useDb(). Nothing references
 * `recipe_ingredients` as a parent, so the DROP is safe regardless; the
 * `foreign_key_check` at the end is there to prove that rather than to fix it.
 */
function rebuildRecipeIngredients(conn: DatabaseSync) {
  const columns = conn
    .prepare('PRAGMA table_info(recipe_ingredients)')
    .all() as { name: string; notnull: number }[]

  const foodId = columns.find((column) => column.name === 'food_id')
  // No table yet (fresh database, SCHEMA_SQL just made it) or already nullable.
  if (!foodId || foodId.notnull === 0) return

  conn.exec('BEGIN')
  try {
    conn.exec(`
      CREATE TABLE recipe_ingredients_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        recipe_food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
        food_id        INTEGER REFERENCES foods(id) ON DELETE RESTRICT,
        grams          REAL NOT NULL,
        serving_label  TEXT,
        serving_count  REAL,
        raw_text       TEXT,
        note           TEXT,
        sort_order     INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (food_id IS NOT NULL OR raw_text IS NOT NULL)
      );

      INSERT INTO recipe_ingredients_new
        (id, recipe_food_id, food_id, grams, serving_label, serving_count,
         sort_order, created_at)
      SELECT id, recipe_food_id, food_id, grams, serving_label, serving_count,
             sort_order, created_at
      FROM recipe_ingredients;

      DROP TABLE recipe_ingredients;
      ALTER TABLE recipe_ingredients_new RENAME TO recipe_ingredients;

      -- Dropped along with the old table. SCHEMA_SQL's IF NOT EXISTS versions
      -- already ran this boot, so they will not put them back.
      CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe
        ON recipe_ingredients(recipe_food_id);
      CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_food
        ON recipe_ingredients(food_id);
    `)

    const violations = conn.prepare('PRAGMA foreign_key_check(recipe_ingredients)').all()
    if (violations.length > 0) {
      throw new Error(
        `recipe_ingredients rebuild left ${violations.length} foreign key violation(s)`,
      )
    }

    conn.exec('COMMIT')
  } catch (err) {
    conn.exec('ROLLBACK')
    throw err
  }
}

/**
 * Add any missing columns, and report which ones were actually added.
 *
 * The return value is what lets a one-time backfill run exactly once: a caller
 * can ask "was this column new this boot?" instead of re-scanning the table
 * every time the app starts to discover there is nothing to do.
 */
function migrate(conn: DatabaseSync): Set<string> {
  const added = new Set<string>()
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(
      (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((row) => row.name),
    )
    for (const [name, declaration] of Object.entries(columns)) {
      if (existing.has(name)) continue
      conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`)
      added.add(`${table}.${name}`)
    }
  }
  return added
}

/**
 * Bring the shared exercise library in line with `shared/activities.ts`.
 *
 * Runs on every boot rather than once, so editing the library file is all it
 * takes to ship a corrected MET value. Upserting **on name** matters: ids stay
 * stable, and `workout_entries` reference them, so a re-sync must never make
 * last month's run point at a different activity.
 *
 * Rows that have dropped out of the library are deleted only when nothing has
 * ever been logged against them — someone's history is worth more than a tidy
 * table, so a retired activity with entries simply stays.
 */
function syncExerciseLibrary(conn: DatabaseSync) {
  const upsert = conn.prepare(
    `INSERT INTO exercises
       (name, category, met, met_light, met_hard, tracks_sets, tracks_distance,
        hint, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(name) WHERE owner_user_id IS NULL DO UPDATE SET
       category        = excluded.category,
       met             = excluded.met,
       met_light       = excluded.met_light,
       met_hard        = excluded.met_hard,
       tracks_sets     = excluded.tracks_sets,
       tracks_distance = excluded.tracks_distance,
       hint            = excluded.hint`,
  )
  const findId = conn.prepare(
    'SELECT id FROM exercises WHERE name = ? AND owner_user_id IS NULL',
  )
  const clearCategories = conn.prepare(
    'DELETE FROM exercise_categories WHERE exercise_id = ?',
  )
  const addCategory = conn.prepare(
    'INSERT OR IGNORE INTO exercise_categories (exercise_id, category) VALUES (?, ?)',
  )

  conn.exec('BEGIN')
  try {
    for (const activity of ACTIVITIES) {
      const mets = metColumns(activity.met)
      upsert.run(
        activity.name,
        activity.categories[0]!,
        mets.met,
        mets.met_light,
        mets.met_hard,
        activity.tracks?.includes('sets') ? 1 : 0,
        activity.tracks?.includes('distance') ? 1 : 0,
        activity.hint ?? null,
      )
      const { id } = findId.get(activity.name) as { id: number }
      clearCategories.run(id)
      for (const category of activity.categories) addCategory.run(id, category)
    }

    const names = ACTIVITIES.map((a) => a.name)
    conn
      .prepare(
        `DELETE FROM exercises
         WHERE owner_user_id IS NULL
           AND name NOT IN (${names.map(() => '?').join(',')})
           AND id NOT IN (SELECT DISTINCT exercise_id FROM workout_entries)`,
      )
      .run(...names)

    conn.exec('COMMIT')
  } catch (err) {
    conn.exec('ROLLBACK')
    throw err
  }
}

/** Run `fn` inside a transaction, rolling back on throw. */
export function transact<T>(fn: (conn: DatabaseSync) => T): T {
  const conn = useDb()
  conn.exec('BEGIN')
  try {
    const result = fn(conn)
    conn.exec('COMMIT')
    return result
  } catch (err) {
    conn.exec('ROLLBACK')
    throw err
  }
}

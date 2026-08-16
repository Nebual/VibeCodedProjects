// Auto-derived from the annotated schema. Single source of truth for the DB shape.
// Applied idempotently on boot by server/utils/db.ts.

export const SCHEMA_SQL = `
-- Fittown schema. Applied idempotently on boot by server/utils/db.ts.

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub    TEXT UNIQUE,              -- Google's stable subject id
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per user. Nutrition targets the diary compares against.
CREATE TABLE IF NOT EXISTS user_goals (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  calorie_goal    REAL NOT NULL DEFAULT 2000,
  -- 25% protein / 45% carbs / 30% fat of 2000 kcal, a common balanced split.
  -- Grams are the stored form; the ratio is derived from them in Settings.
  protein_g       REAL NOT NULL DEFAULT 125,
  carbs_g         REAL NOT NULL DEFAULT 225,
  fat_g           REAL NOT NULL DEFAULT 67,
  fiber_g         REAL NOT NULL DEFAULT 30,
  water_goal_ml   REAL NOT NULL DEFAULT 2500,
  -- 'kg' | 'lb' — display only; weights are always stored in kg.
  weight_unit     TEXT NOT NULL DEFAULT 'kg',
  -- 'ml' | 'floz' — display only; water is always stored in ml.
  volume_unit     TEXT NOT NULL DEFAULT 'ml',
  -- 'metric' | 'imperial'. Which portion unit a food picker starts on, kept
  -- separate from the body-measurement units because plenty of households
  -- weigh food in grams while weighing themselves in pounds.
  food_system     TEXT NOT NULL DEFAULT 'metric',
  -- Add exercise calories back onto the day's remaining budget?
  exercise_adds_calories INTEGER NOT NULL DEFAULT 1,

  -- Body metrics, used to estimate BMR / maintenance calories. All optional:
  -- the app works without them, it just can't calculate a calorie target.
  -- 'male' | 'female' | 'unspecified' | null. Drives which Mifflin-St Jeor
  -- constant is used; 'unspecified' takes the midpoint of the two.
  sex             TEXT,
  -- Age is entered in years and stored as a birth year so it stays correct
  -- as time passes instead of quietly ageing out of date.
  birth_year      INTEGER,
  height_cm       REAL,
  -- 'cm' | 'ftin' — display only; height is always stored in cm.
  height_unit     TEXT NOT NULL DEFAULT 'cm',
  -- One of shared/body.ts ACTIVITY_KEYS; null until the user picks one.
  activity_level  TEXT,

  -- The weight plan set by the calorie target calculator. Kept so Trends can
  -- draw the goal and so the target can be re-derived when weight changes.
  goal_weight_kg        REAL,
  -- Negative = losing, positive = gaining, 0 / null = maintaining.
  goal_rate_kg_per_week REAL,

  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Food database
--
-- Holds both imported Open Food Facts products and user-created custom foods.
-- All nutrient values are per 100 g (or per 100 ml for liquids) so that
-- portion math is a single multiply. Nulls mean "unknown", which is
-- meaningfully different from zero and must not be coerced.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS foods (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,          -- 'off' | 'custom'
  barcode         TEXT,                   -- OFF \`code\`; null for most custom foods
  name            TEXT NOT NULL,
  brand           TEXT,
  quantity        TEXT,                   -- package size as written, e.g. "500 g"
  categories      TEXT,
  image_url       TEXT,

  -- Default serving parsed from OFF (\`serving_size\` text + grams).
  serving_size_text TEXT,
  serving_grams     REAL,

  -- Custom foods belong to the user who made them; OFF foods are shared (null).
  owner_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,

  -- Recipes (source = 'recipe') only. Null on every other row.
  -- How many servings the recipe makes; sets serving_grams when logged.
  recipe_servings       REAL,
  -- The finished/cooked yield, if the user weighed it. Null means unknown,
  -- which is what stops the UI offering gram portions of it — see
  -- shared/recipes.ts.
  recipe_final_weight_g REAL,

  -- Is this measured per 100ml rather than per 100g?
  is_liquid       INTEGER NOT NULL DEFAULT 0,

  -- Macros (per 100g/ml)
  kcal            REAL,
  protein_g       REAL,
  carbs_g         REAL,
  fat_g           REAL,
  fiber_g         REAL,
  sugars_g        REAL,
  added_sugars_g  REAL,
  sat_fat_g       REAL,
  trans_fat_g     REAL,
  mono_fat_g      REAL,
  poly_fat_g      REAL,
  omega3_g        REAL,
  cholesterol_mg  REAL,
  sodium_mg       REAL,
  salt_g          REAL,
  alcohol_g       REAL,
  caffeine_mg     REAL,
  water_g         REAL,

  -- Minerals (mg unless noted)
  potassium_mg    REAL,
  calcium_mg      REAL,
  iron_mg         REAL,
  magnesium_mg    REAL,
  zinc_mg         REAL,
  phosphorus_mg   REAL,
  selenium_ug     REAL,
  copper_mg       REAL,
  manganese_mg    REAL,
  iodine_ug       REAL,

  -- Vitamins
  vit_a_ug        REAL,
  vit_c_mg        REAL,
  vit_d_ug        REAL,
  vit_e_mg        REAL,
  vit_k_ug        REAL,
  vit_b1_mg       REAL,
  vit_b2_mg       REAL,
  vit_b3_mg       REAL,
  vit_b6_mg       REAL,
  folate_ug       REAL,
  vit_b12_ug      REAL,

  nutriscore      TEXT,
  nova_group      INTEGER,

  -- OFF popularity (scan count). Used to rank search results so that the
  -- products people actually buy float to the top.
  popularity      INTEGER NOT NULL DEFAULT 0,

  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_foods_barcode ON foods(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_foods_owner   ON foods(owner_user_id) WHERE owner_user_id IS NOT NULL;
-- Upsert target for the OFF importer. Keying on (source, barcode) keeps food
-- ids stable across re-imports, so existing diary entries never re-point at a
-- different product when the dataset is refreshed. SQLite treats NULLs as
-- distinct, so custom foods without a barcode never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_source_barcode ON foods(source, barcode);

-- Full-text search over name + brand. Kept in sync manually (bulk-rebuilt by
-- the importer, trigger-maintained for custom foods) rather than via an
-- external-content table, so the importer can load rows fast and index once.
CREATE VIRTUAL TABLE IF NOT EXISTS foods_fts USING fts5(
  name,
  brand,
  content='foods',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Named portions for a food, e.g. "1 slice" = 28 g.
CREATE TABLE IF NOT EXISTS food_servings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  food_id   INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  label     TEXT NOT NULL,
  grams     REAL NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_food_servings_food ON food_servings(food_id);

-- ---------------------------------------------------------------------------
-- Recipes
--
-- A recipe *is* a row in \`foods\` (source = 'recipe'), so logging one, searching
-- for it and totalling a day all work through the paths that already exist.
-- This table holds the mixture; the rolled-up per-100g figures are written back
-- onto the food row by recomputeRecipe() in server/utils/recipes.ts, which is
-- the only thing allowed to write them.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  food_id        INTEGER NOT NULL REFERENCES foods(id) ON DELETE RESTRICT,
  -- The resolved amount, exactly as diary_entries stores it: grams are what the
  -- maths uses, the label and count ride along so the row can redisplay
  -- "2 x cup" instead of "480 g".
  grams          REAL NOT NULL,
  serving_label  TEXT,
  serving_count  REAL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The FK asymmetry is deliberate and mirrors diary_entries: deleting a recipe
-- takes its ingredient rows with it, but an ingredient food can never vanish
-- out from under a recipe that uses it.
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe
  ON recipe_ingredients(recipe_food_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_food
  ON recipe_ingredients(food_id);

-- ---------------------------------------------------------------------------
-- Diary
-- ---------------------------------------------------------------------------

-- One logged food. \`grams\` is the resolved amount actually eaten; the
-- serving label/count are kept only so the UI can redisplay "2 x slice".
CREATE TABLE IF NOT EXISTS diary_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,            -- local calendar day, 'YYYY-MM-DD'
  meal          TEXT NOT NULL,            -- 'breakfast'|'lunch'|'dinner'|'snack'
  food_id       INTEGER NOT NULL REFERENCES foods(id) ON DELETE RESTRICT,
  grams         REAL NOT NULL,
  serving_label TEXT,
  serving_count REAL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_diary_user_date ON diary_entries(user_id, date);

CREATE TABLE IF NOT EXISTS water_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  amount_ml  REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_water_user_date ON water_entries(user_id, date);

-- ---------------------------------------------------------------------------
-- Fitness
-- ---------------------------------------------------------------------------

-- Exercise library. Seeded with common activities; users can add their own.
-- \`met\` is the Compendium of Physical Activities metabolic equivalent, used
-- to estimate burn when the user doesn't supply a figure.
CREATE TABLE IF NOT EXISTS exercises (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'cardio',   -- primary category, for badges
  -- \`met\` is the moderate-effort value and the one used when no effort is
  -- given. The other two are null for activities where effort doesn't
  -- meaningfully change the cost (washing dishes, table tennis).
  met           REAL,
  met_light     REAL,
  met_hard      REAL,
  -- Does the activity want sets/reps/weight or distance alongside duration?
  tracks_sets     INTEGER NOT NULL DEFAULT 0,
  tracks_distance INTEGER NOT NULL DEFAULT 0,
  hint          TEXT,                             -- anchors effort to a pace
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exercises_owner ON exercises(owner_user_id);
-- Name is the natural key for the shared library, so the seed can upsert on it
-- and keep ids stable — workout_entries reference them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exercises_shared_name
  ON exercises(name) WHERE owner_user_id IS NULL;

-- An activity belongs to several categories: cycling is cardio and outdoor,
-- gardening is household and outdoor. A join table rather than a delimited
-- column so the category grid can count and filter in SQL.
CREATE TABLE IF NOT EXISTS exercise_categories (
  exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  PRIMARY KEY (exercise_id, category)
);
CREATE INDEX IF NOT EXISTS idx_exercise_categories_cat
  ON exercise_categories(category);

CREATE TABLE IF NOT EXISTS workout_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  exercise_id  INTEGER NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
  duration_min REAL,
  calories     REAL,                       -- resolved burn (estimated or entered)
  -- 'light' | 'moderate' | 'hard' | null. Picks which MET column was used.
  effort       TEXT,
  -- Strength logging
  sets         INTEGER,
  reps         INTEGER,
  weight_kg    REAL,
  distance_km  REAL,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workout_user_date ON workout_entries(user_id, date);

-- ---------------------------------------------------------------------------
-- Body metrics
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS weight_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  weight_kg  REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date)
);

-- Anything else the user wants to track over time: bicep, waist, resting heart
-- rate, body fat. Weight deliberately stays in its own table — it feeds the
-- calorie maths and the BMR estimate, so it is not just another measurement.
--
-- The unit belongs to the *type*, not the value: a bicep measured in inches
-- stays in inches, because converting someone's tape-measure readings behind
-- their back would make the numbers stop matching their notebook.
CREATE TABLE IF NOT EXISTS biometric_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS biometric_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type_id    INTEGER NOT NULL REFERENCES biometric_types(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  value      REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, type_id, date)
);
CREATE INDEX IF NOT EXISTS idx_biometric_entries_user_date
  ON biometric_entries(user_id, date);
`

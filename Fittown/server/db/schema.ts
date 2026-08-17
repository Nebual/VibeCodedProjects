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
  -- 20% protein / 50% carbs / 30% fat of 2000 kcal, a common balanced split.
  -- Grams are the stored form; the ratio is derived from them in Settings.
  protein_g       REAL NOT NULL DEFAULT 100,
  carbs_g         REAL NOT NULL DEFAULT 250,
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

  -- What accepted friends may see. Accepting a friend is one decision; handing
  -- over a diary, a weight history and a training log is five, so each is its
  -- own switch. All default on — a friend you deliberately accepted seeing
  -- nothing at all reads as a broken page rather than as a private one.
  -- Enforced in server/api/friends/**, not just hidden in the UI.
  share_recipes   INTEGER NOT NULL DEFAULT 1,
  share_diary     INTEGER NOT NULL DEFAULT 1,
  share_weight    INTEGER NOT NULL DEFAULT 1,
  share_calories  INTEGER NOT NULL DEFAULT 1,
  share_exercise  INTEGER NOT NULL DEFAULT 1,

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
  -- How to actually make it. Free text, edited by hand, and the landing place
  -- for an imported recipe's steps, times, yield and source URL. Nothing
  -- derives anything from it — it is prose for a human to read while cooking.
  recipe_instructions   TEXT,

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
  sugar_alcohols_g REAL,
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
  -- Nullable since the bulk/URL import landed: a pasted line we couldn't match
  -- to a food with confidence is stored as text and contributes nothing, rather
  -- than being guessed at or minting a nutrition-less placeholder food. See
  -- \`raw_text\` below and server/utils/ingredientMatch.ts.
  food_id        INTEGER REFERENCES foods(id) ON DELETE RESTRICT,
  -- The resolved amount, exactly as diary_entries stores it: grams are what the
  -- maths uses, the label and count ride along so the row can redisplay
  -- "2 x cup" instead of "480 g".
  --
  -- Zero is legal and meaningful: "pinch of salt" has no numeric amount, so it
  -- is stored as 0 g with the descriptor in \`note\`. rollUpRecipe() skips it in
  -- both the weight sum and the nutrient-coverage test, so it neither adds
  -- nutrition nor blanks anybody else's.
  grams          REAL NOT NULL,
  serving_label  TEXT,
  serving_count  REAL,
  -- The line exactly as it was pasted or scraped, kept on matched rows too:
  -- it is what shows that "Balsamic Vinegar of Modena" came from "45g balsamic
  -- vinegar", and it is the only display name an unmatched row has.
  raw_text       TEXT,
  -- The bit of the line that isn't an amount or a name — "a lot of", "minced",
  -- "1 to 2 tbsp". Shown to the user to interpret; never parsed again.
  note           TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- A row with neither a food nor any text is not an ingredient, it's a bug.
  CHECK (food_id IS NOT NULL OR raw_text IS NOT NULL)
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

-- ---------------------------------------------------------------------------
-- Friends and sharing
--
-- The only place in the app where one user reads another's rows. Everything
-- here is deliberately narrow: a friendship is a single row that must be
-- \`accepted\` before it grants anything, and the two link types are bearer
-- tokens with an explicit lifetime rather than guessable ids.
-- ---------------------------------------------------------------------------

-- One row per relationship, in either state. \`requester_id\` is who asked,
-- which is what lets the addressee see "Alice wants to be your friend" and the
-- requester see "waiting on Alice" from the same row.
CREATE TABLE IF NOT EXISTS friendships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'pending' | 'accepted'. A declined request is deleted rather than stored:
  -- keeping it would either block a later re-request or need a third state
  -- nothing reads.
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  CHECK (requester_id != addressee_id)
);
-- A friendship is unordered, so the pair is indexed unordered too: with only a
-- UNIQUE(requester_id, addressee_id) two people who invite each other at the
-- same time end up with two rows, one of which can be accepted while the other
-- stays pending forever. min()/max() are deterministic, so SQLite will index
-- the expression.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair
  ON friendships(MIN(requester_id, addressee_id), MAX(requester_id, addressee_id));
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);

-- "Send your friend a link." Single-use and dated: whoever opens it becomes a
-- friend, so it should stop working once it has done its job.
CREATE TABLE IF NOT EXISTS friend_invites (
  token       TEXT PRIMARY KEY,
  inviter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Free-text label so the inviter can tell two outstanding links apart.
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TEXT,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_friend_invites_inviter ON friend_invites(inviter_id);

-- "Share this recipe with anyone." Independent of friendship, and readable
-- without signing in, which is the whole point of it.
CREATE TABLE IF NOT EXISTS recipe_shares (
  token         TEXT PRIMARY KEY,
  food_id       INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at    TEXT
);
-- At most one live link per recipe, so pressing Share twice hands out the same
-- URL instead of quietly minting a second one the user can never revoke.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_shares_live
  ON recipe_shares(food_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recipe_shares_owner ON recipe_shares(owner_user_id);
`

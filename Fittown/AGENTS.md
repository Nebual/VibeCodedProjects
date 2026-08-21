# Notes for agents working on Fittown

Fittown is a self-hosted nutrition / water / training diary for one family.
Read `README.md` first for what it does and how a human sets it up.
`InitialPrompts.md` holds the user's original brief.

This is the **lean brief**: the commands you need every session and the
non-negotiable invariants that break data *silently* if you break them. Each
invariant is one line here; the full reasoning lives in `docs/*.md`. **Open the
relevant doc before you touch that area** — the reasoning is where the traps
live.

| File | Governs |
| `dev-workflow.md` | Running the dev server, guarding `data/`, the dev login, HTTP smoke tests, verify-your-work layers |
| `nutrients-and-units.md` | Per-100g nutrition, null≠0, food-id stability, timezone, display-only units, exercise library, weight vs biometric |
| `schema-and-db.md` | `SCHEMA_SQL`/`ADDED_COLUMNS`, the one table rebuild, `ensureSchema()`, FTS indexing, `.ts` import extensions, post-migration indexes |
| `recipes.md` | The recipe system: `recomputeRecipe()`, frozen logs, variants, nesting, adjustments, reorder, ingredient matching, scraping, SSRF guard |
| `friends-and-sharing.md` | The one friendship gate, sharing toggles, token-addressed routes, deep copy, friendship pairs, timestamps, link URLs |
| `import-off.md` | Open Food Facts importer: streaming, nutrient caps, liquid/category/duplicate hazards |
| `architecture.md` | Directory layout, schema-as-template-literal, `#shared/*` imports map, stack |
| `proven-and-gaps.md` | What is and isn't proven (incl. Google sign-in behind nginx), and known gaps / ideas for work |

---

## 1. Work here (docker terminal)

Source is at `/workspace` on native container storage.

- **Node v24 every new shell** — the shell doesn't remember it:
  `source "$HOME/.nvm/nvm.sh" && nvm use 24`. A fresh shell answers `node -v`
  as v20; running vitest under it silently passes only the pure-logic tests.
- **Run tests without pnpm:** `node_modules/.bin/vitest run`. `pnpm` aborts in
  the sandbox (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`).
- **Not a git repo on this mount** — `git status` says so. Leave git to the
  user.
- **Dev login is `/auth/dev`**, NOT `/api/auth/dev` (the latter 404s, then every
  authenticated call 401s).
- **Smoke-test against a throwaway DB** so you never touch `data/fittown.db`:
  `FITTOWN_DB_PATH=/tmp/fittown-test.db NUXT_PORT=3100 node_modules/.bin/nuxi dev`,
  then curl with per-user cookie jars.
- Guard `data/`: **never `cp` a live SQLite file** (WAL — the main file can be
  commits behind). Use `VACUUM INTO` / `wal_checkpoint(TRUNCATE)`.
- Long-lived servers detached: `(setsid nohup pnpm dev > /tmp/run.log 2>&1 < /dev/null &)`.
  Killing the dev server: match `nu[x]t.mjs` or by PID (`nux[t]` won't match the
  real cmdline); `NUXT_IGNORE_LOCK=1` bypasses the "already running" lock.

Full workflow & verify layers: `docs/dev-workflow.md`.

---

## 2. Verify your work

```bash
node_modules/.bin/vitest run          # >= 358 unit tests, ~0.8s, no server
node scripts/e2e.mjs                  # >= 38 steps (needs FITTOWN_DEV_LOGIN=1 + running server)
node scripts/screenshots.mjs /tmp/shots  # mobile, dark, desktop — then Actually read them
pnpm build                            # after large changes; catches things dev mode hides
```

Run the unit tests constantly. They deliberately don't boot Nuxt — anything
needing a running app goes in the e2e script. **Look at the screenshots** —
real bugs were visible in pictures, not HTTP codes. If you add tests, break the
thing on purpose once to confirm they notice.

---

## 3. Invariants — break these and data goes quietly wrong

> One line each. Open the linked doc for the full "why" and the war-stories.

### Nutrition & units — `docs/nutrients-and-units.md`
- Nutrition is **per 100 g/ml**. A new nutrient column must appear in
  `shared/nutrients.ts` (key = DB column) *and* the importer's `NUTRIENTS` map.
- **Null ≠ zero.** Never `?? 0` a nutrient for display — a missing value means
  "not recorded", not "you got none". `scaleNutrients()` keeps omitting absent keys.
- **Food IDs must stay stable across re-imports** — importer upserts on
  `(source, barcode)`; change that key and every diary entry re-points.
- **"Today" belongs to the user** (browser `fittown_tz` cookie), never
  server-side `toLocalDate()`. `useToday()` returns `null` until the zone is
  known. The cookie is written in `plugins/timezone.client.ts` **under
  `onNuxtReady`** — moving it reintroduces hydration mismatches.
- **Units are display-only, everywhere**; all conversion lives in
  `shared/body.ts` / `shared/portions.ts`. Food (`food_system`) and body
  (`weight_unit`/`height_unit`) preferences are separate.
- **Exercise library syncs on boot, keyed by name** (`shared/activities.ts`) —
  renaming an activity makes a *new* row so historical ids stay stable.
- **Weight is not just another biometric** — it feeds BMR/targets; don't merge
  it with custom `biometric_*` measurements.
- A pure added sugar's `added_sugars_g` = its `sugars_g`, via
  `isPureAddedSugar()` (`scripts/lib/pureSugar.mjs`); backfill with
  `scripts/fix-added-sugars.mjs`.

### Schema & the database — `docs/schema-and-db.md`
- `foodCols()` emits **table-qualified columns** (`f.id, ...`) — every query
  needs `FROM foods f`.
- `foods_fts` is an **external-content FTS5 table**: any new food-creation path
  must index there too (custom foods do it in `server/api/foods/index.post.ts`).
  **Renaming a food means re-indexing it** (`reindexFood()`).
- Dev login is **double-gated** (`import.meta.dev` && `FITTOWN_DEV_LOGIN=1`);
  it 404s in production builds. Don't loosen it.
- **Adding a column = two edits**: `SCHEMA_SQL` (fresh DBs) *and* `ADDED_COLUMNS`
  in `server/utils/db.ts` (existing DBs). A *type/nullability* change needs the
  one rebuild, `rebuildRecipeIngredients()` (foreign keys off, indexes recreated).
- **Maintenance scripts must call `ensureSchema()` before reading anything**,
  before `PRAGMA foreign_keys = ON` (migrations are lazy — applied on first
  DB-touching request).
- **Anything reachable from `scripts/` needs its `.ts` extension, including
  transitively** — plain `node` doesn't resolve extensionless imports.
- **A new index over a newly-added column goes in `POST_MIGRATION_SQL`**, not
  `SCHEMA_SQL` (which runs before the column exists).

### Recipes — `docs/recipes.md`
- **A recipe is a `foods` row; `recomputeRecipe()` is the only writer of its
  nutrition.** Every mutation route ends with it in-transaction. Basis = yield
  else raw sum; nutrients `null` below `NUTRIENT_COVERAGE_MIN` of weight;
  `food_servings` rebuilt, not patched.
- **An ingredient may have no food** (`food_id` nullable, `raw_text` carries the
  line) **and 0 g is a real amount**. `listIngredients()` decides "unmatched"
  from `ri.food_id IS NULL`. `rollUpRecipe()` skips `null`/`<=0` in *both* weight
  and coverage. Copies carry `raw_text`/`note`.
- **A logged recipe is frozen** (`source = 'recipe_log'`): the diary points at a
  snapshot, not the live recipe. `isRecipe()`/`showsGramPortions()` test
  `RECIPE_SOURCES` membership. Snapshots are never FTS-indexed. `/api/foods/recent`
  groups through `logged_from_food_id`. Delete the entry *before* its snapshot.
  Maintenance selects `source = 'recipe'` exactly.
- **Adjustments land on the frozen copy, never the recipe** — a skipped
  ingredient is still written (`is_included = 0`); the server re-derives the
  portion (`resolveLoggedGrams()`); `resnapshotForLog()` is the only writer to a
  frozen meal; `applyAdjustments()` is the shared authority.
- **Reordering takes the whole list** (compared as sets, not diffed);
  the reorder drag ends on the `window`, not the grabbed handle.
- **Variants are a flat family keyed by `recipe_family_id`** (group key survives
  its founder); `POST …/variants` passes the *source's* family; `copyRecipeInto()`
  starts a new one; a snapshot has none.
- **Nesting:** every mutation ends in `recomputeRecipeAndDependents()` (longest
  distance first, stops at `recipe_log`); named portions re-derived, grams left
  alone; `nestingRefusal()` guards cycles/depth in the route and every picker.
  Maintenance walks recipes children-first.
- **No yield, no grams** — `showsGramPortions()` (`shared/recipes.ts`) is the
  one rule.
- **Never guess which food a written ingredient is** (`matchIngredient()` is a
  gate, not "best result"). Scraping must not assume quoted HTML attributes.
  The URL importer validates every hop (`fetchPage.ts`) — an SSRF guard.

### Friends & sharing — `docs/friends-and-sharing.md`
- **Every route calls `requireUser(event)` and scopes by `user_id`**
  (`WHERE id = ? AND user_id = ?`).
- **Friends are the only exception, and get exactly one gate:**
  `requireSharedSection()` in `server/utils/friends.ts`. 404 for a stranger, 403
  naming the person when a section is off. Never write your own join.
- Sharing is per-category (`shared/sharing.ts`), **absent column reads as shared**.
- **Two** token routes answer without a session (`/api/shared/recipes/[token]`,
  `/api/friends/invites/[token]`); every mutation behind them calls `requireUser`.
- Copying a shared recipe is a **deep copy** of others' custom foods; friendship
  rows are **unordered** (`MIN/MAX` pair index); compare timestamps with
  `comparableTime()`; link URLs are composed in the browser from
  `window.location.origin`.

---

## 4. Layout & stack

`docs/architecture.md` has the full tree. In one breath:

- Stack: Nuxt 4, Tailwind v4, DaisyUI 5, `nuxt-auth-utils`, `node:sqlite`
  (Node 24 built-in — **no** `better-sqlite3`).
- `app/` (components, composables, pages, `plugins/timezone.client.ts`,
  `middleware/auth.global.ts` — private except `/login`, `/r/…`, `/invite/…`)
- `server/` (`api/` REST — `friends/**` is the only cross-user reader;
  `db/schema.ts` single source of truth; `routes/auth/` google/dev/logout;
  `utils/` db, auth, validate, foods, recipes, ingredientMatch, recipeImport,
  fetchPage, summary, friends)
- `shared/` nutrients, activities, body, portions, recipes, ingredientText,
  recipeText, recipeScrape, friends, sharing
- `scripts/` import-off, fix-liquid-flags, reset-user-data, recompute-recipes,
  e2e, screenshots; `test/` Vitest
- `schema.ts` is a TS template literal; `package.json` `#shared/*` imports map
  lets plain-node scripts run the same code the API does (requires the `.ts`
  extension, see above).

Importer internals: `docs/import-off.md`. What's proven (incl. Google behind
nginx) and known gaps: `docs/proven-and-gaps.md`.

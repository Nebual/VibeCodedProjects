# Notes for agents working on Fittown

Fittown is a self-hosted nutrition / water / training diary for one family.
Read `README.md` first for what it does and how a human sets it up. This file
covers the things that will waste your time or silently break data if you
don't know them.

`InitialPrompts.md` holds the user's original brief, if you need the intent
behind a decision.

---

## 1. You cannot `pnpm install` in this directory

The project lives on a **virtiofs mount of the user's Windows drive**. Symlinks
fail outright (`EPERM`) and `rename`/`copyfile` fail intermittently
(`EACCES`/`ENOENT`), so pnpm dies partway through. `node-linker=hoisted` does
not help. A `mount --bind` of native storage over `node_modules` works for a
while and then the sandbox silently drops it, leaving dangling symlinks that
produce baffling "module not found" errors.

**Keep source here (it's the deliverable); run from a native-storage copy.**

```bash
SRC="/c/Users/ben11/Documents/Claude Experiments/Fittown"
RUN=/home/agent/fittown-run

rsync -a --delete \
  --exclude node_modules --exclude .nuxt --exclude .output \
  --exclude data --exclude .pnpm-store \
  "$SRC"/ "$RUN"/

cp "$SRC/data/fittown.db" "$RUN/data/fittown.db"   # first time only
cd "$RUN" && pnpm install && pnpm dev
```

**Re-run the rsync after every edit** — you edit in `$SRC`, the server runs in
`$RUN`. Forgetting this is the single easiest way to debug a bug you already
fixed.

Never commit a `.npmrc` with a sandbox `store-dir`; it isn't portable to the
user's Linux box.

### Guard `data/` while you do this

`$SRC/data/fittown.db` is the **deliverable** and is supposed to contain the
food library and nothing personal. The working copy's database fills up with
test users and junk entries, and it is very easy to clobber one with the other
— it happened during the first build, and again in a later session, both times
*after* the deliverable had already been verified clean. Assume it will happen
to you: re-verify at the end rather than trusting a check from an hour ago, and
treat stray `data/fittown.db-wal` / `-shm` files next to the deliverable as
proof that something opened it for writing. Two rules:

- Keep `--exclude data` on **every** rsync, in both directions.
- Before handing over, regenerate and re-verify rather than trusting an earlier
  check:

  ```bash
  node scripts/reset-user-data.mjs "$RUN/data/fittown.db" --out /tmp/clean.db
  cp /tmp/clean.db "$SRC/data/fittown.db"
  rm -f "$SRC"/data/fittown.db-wal "$SRC"/data/fittown.db-shm
  ```

  Then confirm `users`, `diary_entries` and custom foods are all 0.

**Never copy a live SQLite file with `cp`.** It is in WAL mode, so the main
file alone can be many commits behind — copying `$RUN`'s database mid-session
produced a file showing 2 diary entries when the database really had 26. Either
`PRAGMA wal_checkpoint(TRUNCATE)` first, or use `VACUUM INTO` (which is what
`reset-user-data.mjs --out` does).

**This has already destroyed the deliverable once.** The `data/fittown.db`
shipped before the friends work was **unreadable** — `SELECT … FROM
sqlite_master` returned "database disk image is malformed", so every table in
it, not just the personal ones. Its header was self-consistent (20,042 pages,
file size to match, WAL mode) which is exactly what a main file separated from
its WAL looks like. It was regenerated from `$RUN` with the procedure above and
verified: `quick_check` ok, 203,695 OFF foods, 203,695 FTS rows, a live search
hit, and zero rows in all twelve personal tables.

So: **verify the deliverable, don't assume it.** And verify it *off* the
Windows mount — open a copy on native storage and compare with `md5sum`/`cmp`.
Opening `$SRC/data/fittown.db` in place is its own hazard: even a `readOnly`
connection creates `-shm`/`-wal` beside it over virtiofs, which then looks like
the evidence of tampering this file tells you to treat as a warning sign.

### Shell traps

- `pkill -f "nuxt dev"` **matches the Bash tool's own command line and kills
  your shell** (exit 144). Use a self-avoiding pattern: `pkill -f "nux[t].mjs dev"`,
  or `ps aux | grep '[n]uxt' | awk '{print $2}' | xargs -r kill -9`.
  The bracket trick still fails if the *same command line* later contains the
  plain string (e.g. killing `outpu[t]/server/index.mjs` and then starting
  `.output/server/index.mjs`) — the pattern matches that second occurrence and
  kills your shell anyway. Kill in one call, start in the next.
- Paths contain a space. Quote them, always.
- Start long-lived servers detached: `(setsid nohup pnpm dev > /tmp/run.log 2>&1 < /dev/null &)`.

---

## 2. Verify your work

Two layers, and they cover different things:

```bash
cd $RUN && pnpm test                     # 358 unit tests, ~0.8s, no server needed
cd $RUN && node scripts/e2e.mjs          # 38 steps, fails on any console error
node scripts/screenshots.mjs /tmp/shots  # mobile, dark, desktop — then Read them
pnpm build                               # catches things dev mode hides
```

**Unit tests** (`test/*.test.ts`, plain Vitest — see `vitest.config.ts`) cover
the pure logic: the nutrient catalogue and its null-vs-zero invariant, portion
units, body/energy maths, the activity library's internal consistency, the
request validators, the recipe roll-up (yields, the coverage rule, when gram
portions may be offered), the invite-expiry and copy-naming rules, the
ingredient parser, the recipe scraper (against a saved copy of a real Love and
Lemons page), the URL guard's private-address ranges, how an ingredient row
reads on screen when it has no food, and — against a real temp
SQLite file — the boot-time schema migration, the `recipe_ingredients` rebuild,
the exercise-library sync, `recomputeRecipe()`, ingredient matching, recipe
import, the friendship access gate and the deep recipe copy.
They run in half a second, so run them constantly. They deliberately do **not** boot Nuxt; anything needing a
running app belongs in the e2e script instead.

The unit suite was mutation-checked when written: a wrong Mifflin-St Jeor
constant, a `?? 0` slipped into `scaleNutrients`, and a forgotten
`ADDED_COLUMNS` entry each failed the tests you'd expect and nothing else. The
friends tests were checked the same way — disabling the per-section permission
check, making the recipe copy shallow, ordering the friendship pair index, and
dropping the timestamp normalisation each failed exactly their own tests. If you
add tests, break the thing on purpose once and confirm they notice.

`scripts/e2e.mjs` needs `FITTOWN_DEV_LOGIN=1` in `.env` and a running dev
server. **Actually look at the screenshots** — several real bugs here (oats
measured in millilitres, a blank diary, "0.0 µg 0%" for unknown nutrients) were
invisible in HTTP status codes and obvious in a picture.

Route-level smoke tests are not enough: `POST /api/foods` returned 200 on every
page load I checked and was still completely broken (`no such column: f.id`),
because nothing exercised it until the e2e run.

---

## 3. Invariants — break these and data goes quietly wrong

**Nutrition is stored per 100 g/ml.** Everything else is a multiply. If you add
a nutrient column, add it to `shared/nutrients.ts` (key must match the DB
column) and to the importer's `NUTRIENTS` map with its unit scale and cap.

**Null ≠ zero.** Open Food Facts records maybe a third of micronutrients. A
missing value stays `null` all the way to the UI, which renders "not recorded".
Never `?? 0` a nutrient for display — it tells someone they got no vitamin D
when the truth is we don't know. `scaleNutrients()` omits absent keys
deliberately; keep it that way.

**Food IDs must stay stable across re-imports.** The importer upserts on
`(source, barcode)`. If you change that key, every existing diary entry
re-points at a different product. There is no nutrient snapshot on
`diary_entries` — stability *is* the integrity mechanism.

**"Today" belongs to the user, not the server.** The browser's IANA timezone
goes in a `fittown_tz` cookie; the server computes the date in that zone.
Never call `toLocalDate()` server-side to decide what day it is — a UTC host
serving a phone in Toronto is a different day for five hours every evening.
`useToday()` returns `null` until the zone is known; callers must treat that as
"don't fetch yet" so SSR and the first client render agree.

**The timezone cookie is written in `plugins/timezone.client.ts` under
`onNuxtReady`** — deliberately after hydration finishes. Moving it to setup or
`onMounted` reintroduces hydration mismatches (both were tried).

**`foodCols()` emits table-qualified columns** (`f.id, f.name, …`). Any query
using it needs `FROM foods f`. Both `foods` and `diary_entries` have `id` and
`created_at`, so unqualified lists are ambiguous or silently overwrite.

**`foods_fts` is an external-content FTS5 table.** The importer bulk-rebuilds
it; custom foods insert their own row in `server/api/foods/index.post.ts`. If
you add another path that creates a food, index it there too or it won't be
searchable. The e2e script asserts this.

**The dev login is double-gated** (`import.meta.dev` *and* `FITTOWN_DEV_LOGIN=1`)
and 404s in a production build even with the env var set. Verified — don't
loosen it.

**Changing a column's *type or nullability* takes a table rebuild, and there is
exactly one.** SQLite has no `ALTER COLUMN`, so `ADDED_COLUMNS` cannot express
it. `rebuildRecipeIngredients()` in `server/utils/db.ts` creates the new shape,
copies the rows, drops, renames and **recreates both indexes** (SCHEMA_SQL's
`IF NOT EXISTS` versions have already run this boot and will not put them back).
It is guarded on the thing it fixes — `food_id`'s `notnull` flag — rather than a
version number, so it is a no-op on every subsequent boot. It must run with
foreign key enforcement **off**, which is why `PRAGMA foreign_keys = ON` sits
*after* it in `useDb()` rather than up with the other pragmas; the pragma cannot
be changed inside a transaction. Verified against a copy of the shipped
`data/fittown.db`: 203,695 foods and their FTS rows intact, `quick_check ok`,
no foreign key violations.

**Adding a column takes two edits, not one.** `SCHEMA_SQL` is all
`CREATE TABLE IF NOT EXISTS`, which does nothing to a table that already
exists — so a new column there reaches fresh databases only, and every existing
one throws "no such column" on the next query. Add it to `SCHEMA_SQL` *and* to
`ADDED_COLUMNS` in `server/utils/db.ts`, which ALTERs it in on boot after
checking `PRAGMA table_info`. Entries in `ADDED_COLUMNS` are permanent; that
list is how an old database catches up. Verified against the shipped
`data/fittown.db` (old schema, 203,695 foods): it gains the columns on first
DB-touching request and loses nothing.

Note the migration is **lazy** — `useDb()` runs it on first use, so a request
that 401s before touching the database won't trigger it. That is fine in
practice and confusing when testing; hit an authenticated route.

**Units are display-only, everywhere.** kg for weight, cm for height, ml for
volume, grams for portions — always, whatever the user typed. `shared/body.ts`
and `shared/portions.ts` own every conversion; if you find a `* 2.20462` in a
component, move it. Food and body measurements have *separate* preferences
(`food_system` vs `weight_unit`/`height_unit`) because Canadian households
routinely weigh food in grams and themselves in pounds.

**The exercise library syncs on every boot, keyed by name.**
`shared/activities.ts` is the source of truth; `syncExerciseLibrary()` upserts
it into `exercises` on `name` (a partial unique index over
`owner_user_id IS NULL`). Name is the natural key **because ids must stay
stable** — `workout_entries` reference them, and re-seeding by delete-and-
insert would silently re-point last month's runs at different activities.
Renaming an activity in that file therefore creates a new row; the old one
survives if anything was logged against it, and is dropped otherwise.

MET values come from the 2024 Adult Compendium (pacompendium.com). Where an
activity has measured light/moderate/vigorous rows we store all three
(`met_light`, `met`, `met_hard`); `met` alone means effort doesn't change the
cost and the UI hides the picker. Interpolated middles are flagged `estimated`
in the library — fix those first if better data turns up.

**Weight is not just another biometric.** It lives in `weight_entries` and
feeds BMR, the calorie target and every workout estimate. Custom measurements
live in `biometric_types` / `biometric_entries` and feed nothing. Don't merge
them for tidiness. Biometric units belong to the *type* and values are stored
as entered — converting someone's tape-measure readings would make them stop
matching their notebook.

**A recipe is a `foods` row, and `recomputeRecipe()` is the only thing allowed
to write its nutrition.** `source = 'recipe'`, ingredients in
`recipe_ingredients`, nutrient columns derived from them. That is what makes
logging, search, "Frequent", day totals and the portion picker work with no
recipe-shaped code in them. Every mutation route ends with a
`recomputeRecipe(db, id)` inside the same transaction; hand-editing a recipe's
nutrient columns gives you a food row that disagrees with its own ingredients
and nothing to notice it with. Three rules live inside it:

- **The basis is the yield if stated, else the raw ingredient sum**, and an
  empty recipe has a basis of 0 — otherwise deleting the last ingredient from a
  recipe someone had already weighed leaves a serving size with no nutrition
  under it, and the diary logs a portion worth nothing.
- **A nutrient is `null` unless ingredients covering ≥ `NUTRIENT_COVERAGE_MIN`
  of the raw weight declare it** (`shared/recipes.ts`). Summing only the
  ingredients that happen to record iron and presenting it as the recipe's iron
  is the same lie as `?? 0`.
- **`food_servings` is rebuilt, not patched.** The picker reads it verbatim, so
  a stale "whole recipe = 900 g" logs the wrong amount without looking wrong.

**An ingredient may have no food, and 0 g is a real amount.** Both come from
the recipe importer. A pasted or scraped line the matcher can't identify with
confidence is stored as text — `recipe_ingredients.food_id` is **nullable**,
with `raw_text` carrying the line — rather than being guessed at or turned into
a nutrition-less placeholder food. A line with no numeric amount ("pinch of
salt", "a lot of oregano") is stored at 0 g with the descriptor in `note`.
Three consequences worth knowing before you touch this code:

- **`listIngredients()` decides "unmatched" from `ri.food_id IS NULL`, never
  from `f.id IS NULL`.** The join is a LEFT join, so a miss fills all forty of
  `foodCols()`'s columns with nulls, and the spread would otherwise hand back an
  object with `name`, `kcal` and `is_liquid` all null that looks exactly like a
  real food row. `IngredientRow.food` is `null` or a whole row, never a husk.
- **`rollUpRecipe()` skips `food === null` and `grams <= 0` in *both* the weight
  sum and the coverage test, and the two must agree.** An ingredient that adds
  no weight must not sit in the coverage denominator either — otherwise a 0 g
  pinch of salt counts as weight declaring no vitamin K and blanks the whole
  recipe's vitamin K.
- **Copies carry unmatched lines.** `copyRecipeInto()` LEFT joins and brings
  `raw_text`, `note` and `recipe_instructions` across. A deep copy that dropped
  them hands someone a vinaigrette with no salt and nothing on screen to say so.

**A logged recipe is frozen, and the frozen copy is a `foods` row too.**
`POST /api/diary/entries` clones the recipe and its ingredients into a row with
`source = 'recipe_log'` (`snapshotRecipeForLog()`), and the entry points at the
clone — which is what stops adding butter today changing what last Tuesday's
bowl reports. The clone is minted and rolled up exactly once; after that it is a
record, not a derivation. Five rules hold it together, and four of them fail
*silently*:

- **`isRecipe()` and `showsGramPortions()` test membership of `RECIPE_SOURCES`,
  never equality with `RECIPE_SOURCE`.** A frozen stew that fails those tests is
  treated as an ordinary food, and the diary starts quoting a gram weight for a
  dish nobody weighed — in the screen people read most often.
- **A snapshot is never written to `foods_fts`** (`createRecipeFood()` skips the
  index for it) and is refused as a direct log target. Never being indexed is a
  stronger guarantee than filtering it out of the queries that read the index —
  and note that `SELECT ... FROM foods_fts WHERE rowid = ?` answers yes for
  every food whether indexed or not, because the table is external-content. Ask
  with `MATCH`.
- **`/api/foods/recent` groups through `logged_from_food_id`**
  (`listFrequentFoods()` in `server/utils/foods.ts`). Grouping by `d.food_id`
  fills Frequent with thirty "eaten once" omelettes and loses the recipe.
- **Delete the diary entry *before* its snapshot.** `diary_entries.food_id` is
  ON DELETE RESTRICT, so the other order fails the whole transaction.
  `deleteRecipeLog()` is scoped to the owner and to `recipe_log`, so it refuses
  anything else it is handed.
- **`recompute-recipes.mjs` and `import-off.mjs` select `source = 'recipe'`
  exactly.** Broadening either to `RECIPE_SOURCES` in a tidy-up would recompute
  every frozen meal against today's food library, which is the one thing all of
  this exists to prevent.

Because nothing in the diary references the live recipe any more, **a recipe you
have eaten can now be deleted** — the meals survive and their
`logged_from_food_id` goes null. The 409 in `recipes/[id].delete.ts` still
stands for entries logged *before* this change, which point straight at the
recipe with no snapshot under them.

**A maintenance script must call `ensureSchema()` before it reads anything.**
The app applies `ADDED_COLUMNS` *lazily*, on the first request that touches the
database, so a file that has not been served since the last release is missing
whatever that release added — and a script that opens it directly dies partway
through with a bare "no such column" (`f.logged_from_food_id`, from
`foodCols()`, is how this was found). `ensureSchema()` in `server/utils/db.ts` is
the same catch-up `useDb()` runs, factored out for exactly this: idempotent, a
no-op on a current database, and it must be called **before**
`PRAGMA foreign_keys = ON` because part of it rebuilds a table.
`snapshot-diary-recipes.mjs`, `recompute-recipes.mjs` and both importers all go
through it. `test/scripts-smoke.test.ts` runs the first two as real child
processes against a deliberately old fixture, which is the only way to catch
either this or the rule below.

**An import reachable from `scripts/` needs its `.ts` extension — including
transitively.** §5 says this about the scripts themselves; the trap is that it
applies to every module they reach. `server/utils/db.ts` imported
`'../db/schema'`, which Nuxt, Vite and Vitest all resolve happily and plain
`node` does not, so the whole thing failed with ERR_MODULE_NOT_FOUND the first
time a script imported it — while every test still passed. If you add an import
to anything under `server/utils/`, give it the extension.

**A new index over a newly-added column cannot go in `SCHEMA_SQL`.**
`db.exec(SCHEMA_SQL)` runs *before* `migrate()`, so on a database that predates
the column `CREATE INDEX ... ON foods(recipe_family_id)` fails with "no such
column" — `IF NOT EXISTS` suppresses the index-already-exists error and nothing
else — and takes the boot down for every existing user. `POST_MIGRATION_SQL` in
`server/db/schema.ts` runs immediately after `migrate()` instead. `migrate()`
now returns the set of columns it added, which is what lets a one-time backfill
(`recipe_family_id = id`) run exactly once rather than re-scanning 200k rows on
every boot.

**An ingredient can be optional, and that takes two flags.**
`recipe_ingredients.is_optional` says the UI offers a switch for it;
`is_included` says whether it currently counts. Bacon on top is
`optional, not included`; almond flour beside flour is the same; an optional you
usually do add is `optional, included`. Only `is_included` touches the
arithmetic, and it does so through the **one** predicate in `rollUpRecipe()`
(`ingredientIsIncluded()`), which must keep gating the weight sum *and* the
coverage denominator together — 200 g of skipped bacon left in the denominator
blanks the recipe's vitamin K on the strength of weight that isn't there.
**Absent reads as included**, matching the column default, so every row and every
fixture that predates the columns behaves exactly as it did.
`is_optional = 0` implies `is_included = 1`; that wants a `CHECK`, cannot have
one without a table rebuild, and is enforced in the two ingredient routes —
clearing `is_optional` switches it back on, or the recipe keeps a permanently
missing ingredient with no control on screen to bring it back.

**A meal's adjustments land on the frozen copy, never on the recipe.**
"Three eggs instead of four, no bacon, a bit more cheddar" arrives as
`adjustments` on `POST /api/diary/entries`, is validated by `assertAdjustments()`
(`server/utils/adjustments.ts`), and is applied by `cloneRecipe()` *while it
copies* — keyed by the source recipe's ingredient ids, because the copy's rows
don't exist yet and mapping between them afterwards is a second thing to keep
right. Four rules:

- **A skipped ingredient is still written**, with `is_included = 0`. The frozen
  copy is a record of a meal, and "no bacon" is part of what happened.
- **The server re-derives the portion.** The client sized "1 serving" against the
  recipe as written; the adjusted copy weighs something else.
  `resolveLoggedGrams()` recomputes it — and is the same `nestedPortionGrams()` a
  nested recipe uses, because it is the same question. A portion entered in grams
  is left exactly as typed.
- **`resnapshotForLog()` is the only thing that writes to a frozen meal**, and it
  is scoped to `RECIPE_LOG_SOURCE` and to the owner. It is safe *because* the copy
  belongs to exactly one diary row, so editing it is the same act as editing that
  row. It re-derives nutrition from the ingredient foods as they are now, which is
  right: re-saving is a fresh act of logging.
- **`applyAdjustments()` is the shared authority** for what is actually in the
  bowl. The log screen calls it to size the portion and draw the preview; the
  server calls it again to build the copy. Two implementations would drift, and
  the one nobody was looking at would be the one in the diary.

**Reordering takes the whole list.** `PATCH /api/recipes/[id]/ingredient-order`
sends every ingredient id, and `reorderIngredients()` refuses anything else —
compared as **sets**, so a duplicate id is caught too (`[7, 7]` against two rows
has the right length and would leave one row where it was). A client working from
a stale copy would otherwise scramble the rows it didn't know about, and the rows
it did send would look right. The path is deliberately not `ingredients/order`,
which would sit beside `[ingredientId].patch.ts` and depend on
static-beats-dynamic routing not to be read as an ingredient called "order".

**A drag ends on the `window`, never on the thing you grabbed.** The reorder
handle in the recipe editor binds only `pointerdown`; `useDragSort` then listens
for `pointermove`/`pointerup`/`pointercancel`/`blur` on the window for the
duration. This was a bug, and it is an easy one to reintroduce because binding
the handlers to the handle looks obviously right: `setPointerCapture` is supposed
to guarantee the handle receives the release, but **capture is lost when the
captured element is moved in the DOM** — which is exactly what reordering a list
live does. The release then landed on whatever was under the pointer, `dragging`
never cleared, and the next move over any handle picked the drag back up, so rows
followed the mouse until you clicked the handle again. A second guard backs it up:
a `pointermove` with `buttons === 0` ends the drag, because a release we never
heard about is still a release. The e2e step "a drag stops when you let go of it"
drops capture deliberately mid-drag and then wanders the pointer back over the
handles; without both guards it fails.

**Variants are a flat family, keyed by `recipe_family_id`.** Every member holds
the id of whichever of them was created first — set on insert in
`createRecipeFood()`, because the id doesn't exist until the row does, and
backfilled once for recipes that predate the column. Flat rather than a tree
because "the three ways I make chili" have no natural parent, and a tree would
make deleting the first one a question about the other two instead of just a
deletion: **a group key survives its founder**, which is the property
`listVariants()` and the strip on the recipe page depend on. Three things to keep
right:

- **`POST /api/recipes/[id]/variants` must pass the *source's* family**, not mint
  a new one. Nothing in the unit suite can see this — the route is the only place
  it happens — so the e2e step "variants are linked, and you can walk between
  them" is the guard, and it checks the link in *both* directions, because a
  one-way link means the id went on the wrong row.
- **`copyRecipeInto()` starts a new family.** Someone who copies your chili
  copied one recipe, not your collection.
- **A snapshot has no family** (`familyId: null` in `createRecipeFood()`), which
  is also what keeps frozen meals out of `variant_count` and out of the strip.

**A recipe may contain another recipe, and three rules keep that from going
wrong.** The ingredient's `food_id` points at a `foods` row with
`source = 'recipe'`; the arithmetic needs nothing new, because a recipe already
carries real per-100 g values.

- **Every mutation route ends in `recomputeRecipeAndDependents()`, never
  `recomputeRecipe()`.** A parent caches the sum of its children, so editing the
  dressing leaves the salad wrong until the salad is re-rolled. The order is by
  **longest** distance from the recipe that changed: with a diamond (A holds B
  and C, B holds C) a depth-first walk up from C can reach A before B, roll A up
  from a stale B, and then skip A because it has been visited. **The walk stops
  at `recipe_log`** — reaching a frozen meal would rewrite the history the
  snapshot exists to protect.
- **`recomputeRecipe()` re-resolves a nested recipe's *named* portions**
  (`resolveNestedPortions()` + `nestedPortionGrams()`). "1 serving of the
  dressing" is a claim about a share of something that can change underneath it,
  so the grams are re-derived from the child's current row every time. An amount
  entered *in grams* is left exactly as entered — somebody weighed that, and a
  weight is not a proportion. This is the only write a recompute makes to
  `recipe_ingredients`, and it is deliberate.
- **`nestingRefusal()` is checked before an ingredient is stored, and again in
  every picker.** It refuses a recipe that already contains the parent (walking
  down with a recursive CTE, `UNION ALL` plus a depth guard so a cycle that
  somehow exists answers instead of hanging) and a stack deeper than
  `MAX_RECIPE_DEPTH`, measured **from both sides** — a two-level child dropped
  into a two-level parent is too deep although neither half is. `for_recipe=<id>`
  on `/api/foods/search`, `/api/foods/recent` and `/api/recipes` leaves the
  recipe and its ancestors out of what is offered; Frequent is the one list that
  would otherwise hand back a cycle, since it is built from what you ate rather
  than what you searched for.

Two consequences elsewhere. **The maintenance scripts must walk recipes
children-first** — `recipesInDependencyOrder()`, used by `recompute-recipes.mjs`
and both importers; `ORDER BY id` rolls a salad up from a stale dressing if the
salad happens to have the lower id. And **`copyRecipeInto()` recurses**: a
nested child sent through `copyCustomFoodInto()` would arrive as a flat
`source = 'custom'` food with the right calories, no ingredient list, and no way
to tell it had ever been a recipe. The `localised` map is shared through the
recursion so one dressing used twice is copied once.

**"No yield, no grams" now applies to ingredient rows too.** `portionText()`
drops the gram gloss beside "1 × serving" of a recipe nobody weighed — the
weight behind it is what went *into* the batch. It keeps the figure when there
is no named portion to show instead, because then it is the only amount on the
row.

**Never guess which food a written ingredient is.** `matchIngredient()` in
`server/utils/ingredientMatch.ts` is a set of conditions a candidate has to
clear, not "best search result wins". A wrong match produces a
finished-looking recipe whose calories are silently off; an unmatched line
produces a visible warning. Two rules do the work, and both were found by
running the importer against the real 203k-row library:

- **Extra words in the candidate name are only allowed for multi-word queries**
  (`maxExtraWords`). "salt" matched **Salt & Vinegar** — a crisp flavour —
  until a one-word query was made to demand an exact match.
- **`FORM_WORDS` rejects candidates that are a different *form* of the food** —
  spray, powder, dried, canned. "avocado oil" otherwise matches "Avocado Oil
  Cooking Spray": every query word is present and the search ranks it first.

**Recipe scraping must not assume quoted HTML attributes.** Love and Lemons
serves `<script type=application/ld+json class=yoast-schema-graph>` — minifiers
strip quotes routinely. A pattern requiring them finds no structured data,
falls silently through to the heading scrape, and imports a recipe made of
navigation links. `attr()` in `shared/recipeScrape.ts` matches all three forms;
the saved fixture deliberately reproduces the unquoted markup so the test would
catch a regression.

**The URL importer fetches from inside your network, so it validates every
hop.** `server/utils/fetchPage.ts` rejects non-http(s) schemes, private and
loopback addresses (checked *numerically* — `172.66.41.15` is public and
`172.16/12` stops at `172.31`, so a prefix match on "172." would block a slice
of the internet), and `localhost` by name; it follows redirects with
`redirect: 'manual'` and re-validates each one, because validating only the URL
the user typed is the standard way an SSRF guard gets walked around.

**No yield, no grams.** `showsGramPortions()` in `shared/recipes.ts` is the one
rule, used by the portion picker, the diary and the search results. A recipe
nobody weighed is measured in servings only: its internal basis is what went
*into* the pot, and quoting that as the weight of a dish that spent an hour
boiling down would be inventing a number. Servings stay exact either way, which
is why they're what we offer.

**Renaming a food means re-indexing it.** `foods_fts` is external-content, so a
delete has to replay the *old* values — read them before the UPDATE and use
`reindexFood()`. Skip it and the old name keeps turning up in search.

**Every API route calls `requireUser(event)` and scopes queries by `user_id`.**
Deletes/updates use `WHERE id = ? AND user_id = ?` so a guessed ID is a no-op.
Keep that pattern.

**Friends are the *only* exception to that rule, and they get exactly one
gate.** `requireSharedSection(db, viewerId, ownerId, key)` in
`server/utils/friends.ts` is the single place that decides whether one person
may read another's rows. Every route under `server/api/friends/**` calls it
first; nothing else opens that door. If you add a friend-scoped endpoint, call
it — don't write your own join. A missed check here leaks a health diary, not a
preference. Two refusals, deliberately different:

- **404 for a stranger** — whether a given user id exists is not something an
  outsider should be able to probe, and "you have no such friend" is also the
  honest answer.
- **403 naming the person** when they *are* a friend but have switched that
  section off, so the page can say why instead of looking broken.

Sharing is per-category (`share_recipes`, `share_diary`, `share_weight`,
`share_calories`, `share_exercise` on `user_goals`, all defaulting to 1). The
catalogue lives in `shared/sharing.ts`; Settings, the gate and the friend view
all read it, so adding a switch is one entry plus a column in both places (see
the two-edit rule above). **An absent column reads as shared**, matching the
default — a database that predates the migration must not blank a friend's page.
Enforcement is server-side: `/api/friends/[id]/summary` strips the sections its
owner withheld on the way out, and the UI merely hides what it wasn't given.

**Two token-addressed routes answer without a session**, and they are the only
ones: `/api/shared/recipes/[token]` and `/api/friends/invites/[token]`. Both
take an unguessable token (16 random bytes, base64url) rather than an id, both
return one object and a display name, and every *mutation* behind them still
calls `requireUser`. `app/middleware/auth.global.ts` lets `/r/` and `/invite/`
through to match; everything else stays private by default.

**Copying a shared recipe is a deep copy**, and has to be. `copyRecipeInto()`
references Open Food Facts ingredients as they are but duplicates any ingredient
that is somebody's *custom* food, because pointing at a row you can't see gives
you a recipe that changes when they edit it, vanishes from your search, and
pins their food in place for ever (`recipe_ingredients.food_id` is ON DELETE
RESTRICT). The duplicate drops its barcode: `(source, barcode)` is unique, so
carrying it across collides with the row being copied.

**A friendship row is unordered.** `idx_friendships_pair` is unique over
`MIN(requester_id, addressee_id), MAX(...)`, not over the ordered pair — two
people inviting each other at the same moment otherwise get two rows, one of
which stays pending for ever. `requestFriendship()` treats "I asked you while
you were asking me" as mutual consent.

**SQLite and JavaScript write timestamps differently** (`2026-08-16 12:00:00`
vs `2026-08-16T12:00:00.000Z`), and `' '` sorts before `'T'`. Comparing an
`expires_at` against `new Date().toISOString()` raw makes a link read as expired
for the rest of the day it was issued. `comparableTime()` in `shared/friends.ts`
normalises both; use it rather than comparing strings by hand.

**Link URLs are composed in the browser, from `window.location.origin`.** The
API returns tokens only. Deriving a public URL server-side means guessing the
hostname and scheme from request headers — the same guess that broke Google
sign-in behind nginx (§6).

---

## 4. Open Food Facts is crowd-sourced and dirty

`scripts/import-off.mjs` streams a 1.3 GB gzipped CSV and filters as it goes;
the ~10 GB uncompressed file is never written to disk. Don't "simplify" it into
downloading the file first — disk here is tight.

Real hazards already handled, with the reasoning in comments:

- **Unit-entry errors.** A blanket "≤100 g per 100 g" check passes a value that
  becomes 9,375,000 µg of vitamin D. Every nutrient has a per-nutrient
  physiological ceiling *in its output unit*. Pure salt legitimately is ~38,800
  mg sodium/100 g, so the caps are generous but finite.
- **kJ typed into the kcal field.** Stated calories are cross-checked against
  the Atwater estimate; macros win if they disagree by more than 2×.
- **Category umbrellas.** `"Plant-based foods and beverages"` sits on oats and
  olive oil and contains the word "beverages" — it mis-flagged 29,228 foods as
  liquids. `scripts/lib/liquid.mjs` strips `foods and beverages` umbrellas
  before matching, and only accepts a liquid word in final position in a name.
  62% of products have no categories at all.
- **Duplicates.** Many near-identical rows per product. Search de-duplicates by
  name+brand **in SQL, before the limit** — dedup after a small over-fetch
  collapsed "cheerios" to a single result.

If you change classification rules, `scripts/fix-liquid-flags.mjs` recomputes
in place (~10 s) instead of a two-minute re-import.

---

## 5. Layout

```
app/
  components/    CalorieSummary, MealSection, WaterTracker, FitnessSection,
                 BodyMeasurements, CalorieTargetDialog, ActivityPicker,
                 MetricChart (weight + any custom biometric),
                 TrendsPanel (the whole trends screen, pointed at your own
                   summary endpoint or a friend's),
                 NutrientBreakdown, FoodResultList, BarcodeScanner, DateNav,
                 RecipeReadOnly (a recipe you don't own — friend or link),
                 FriendRequestPrompt (the accept prompt, in the layout),
                 AppIcon (inline SVG set — no icon dependency)
  composables/   useDiary (day data + all mutations), useToday (timezone),
                 useRecipes / useFriends (response shapes)
  layouts/       default.vue, public.vue (signed-out link targets)
  pages/         index (diary), add, food/[id], food/new, recipes/index,
                 recipes/[id], fitness, trends, settings, login,
                 friends/index, friends/[id]/index,
                 friends/[id]/recipes/[recipeId],
                 invite/[token], r/[token] (both readable signed out)
  plugins/       timezone.client.ts
  middleware/    auth.global.ts — private except /login, /r/…, /invite/…
server/
  api/           REST endpoints; diary/index.get.ts assembles a whole day;
                 friends/** is the only place one user reads another's rows;
                 shared/recipes/[token].get.ts is the only unauthenticated one
  db/            schema.ts (single source of truth)
  routes/auth/   google.get.ts, dev.post.ts, logout.post.ts
  utils/         db, auth, validate, foods (search ranking lives here),
                 recipes (recomputeRecipe, the FTS re-index, the deep copy),
                 ingredientMatch (when a written line may claim a food),
                 recipeImport (parsed lines -> a recipe, both importers),
                 fetchPage (the URL importer's SSRF + size/time guards),
                 summary (the trends rollup, yours and a friend's),
                 friends (friendship storage + the one access gate)
shared/          nutrients.ts  — nutrient catalogue used by both sides
                 activities.ts — exercise library, categories, effort METs
                 body.ts      — units, activity levels, BMR/TDEE, target maths
                 portions.ts  — portion units and their gram equivalents,
                                plus RECIPE_UNITS for the importer's parser
                 recipes.ts   — recipe roll-up, coverage rule, gram-portion rule
                 ingredientText.ts — one written line -> amount + name + note
                 recipeText.ts     — paste sections, instructions block, yield
                 recipeScrape.ts   — JSON-LD / microdata / heading extraction
                 friends.ts   — invite lifetime, copy naming, token shape
                 sharing.ts   — the five sharing switches and their defaults
scripts/         import-off, fix-liquid-flags, reset-user-data,
                 recompute-recipes, e2e, screenshots
test/            Vitest unit tests (pure logic + schema migration + the
                 friendship gate, recipe copy, recipe import and the
                 frozen-meal snapshot against a temp
                 database); test/fixtures/ holds a saved real recipe page
```

`server/db/schema.ts` is a TS template literal rather than a `.sql` file so
bundling is deterministic in production. Applied idempotently on every boot.

`package.json` carries an `imports` map for `#shared/*`, mirroring the alias
Nuxt sets up. It exists so the plain-`node` scripts in `scripts/` can import the
app's own modules — `recompute-recipes.mjs` runs the same `recomputeRecipe()`
the API does instead of keeping a second copy of the arithmetic. Node resolves
ESM specifiers literally, so imports reached that way need their `.ts`
extension (`./foods.ts`); Nuxt, Vite and Vitest are all happy with it.

Stack: Nuxt 4, Tailwind v4 (`@tailwindcss/vite`, no config file), DaisyUI 5
(configured in `app/assets/css/main.css` via `@plugin`), `nuxt-auth-utils`,
`node:sqlite` (built into Node 24 — **no native module**, don't add
`better-sqlite3`).

---

## 6. What is and isn't proven

Verified working: the full logging journey (e2e script), search (22–104 ms over
203,695 foods), barcode lookup incl. UPC-A/EAN-13 zero-padding and 404s,
custom foods, goals, trends, dark mode, production build, the production
security posture (dev login 404, API 401, `/` redirects), and — as of the
user's own deployment — **Google sign-in end to end**, behind nginx with TLS
termination.

Friends and sharing were checked the same way, with three signed-in people and
an anonymous visitor: request by email → prompt → accept, invite links
(multi-use, cancellable, self-accept refused, previewable signed out), a
friend's trends / recipes / diary, each of the five switches closing its own
door on the *server* (403) and not merely in the UI, copying by friendship and
by public link, revocation (410, with copies already taken unaffected), and
unfriending (access stops at once, copies survive, and the two can start over).
In production: every friend and copy route 401s without a session, the two
token routes answer without one, a junk token 404s, and the public recipe page's
HTML carries no email address.

That last one took one fix, and it will catch out the next person who deploys
behind a proxy. The callback URL is derived from the incoming request
(`getOAuthRedirectURL` → h3's `getRequestURL`). h3 honours
`x-forwarded-proto: https` but otherwise falls back to whether the *socket* is
encrypted — which behind nginx it isn't — so the app built
`http://host/auth/google` and Google rejected the flow with
`redirect_uri_mismatch`. The fix is `proxy_set_header X-Forwarded-Proto $scheme;`
in the nginx location block (README has the full snippet); confirmed working in
production. `NUXT_OAUTH_GOOGLE_REDIRECT_URL` pins the URL outright if you'd
rather not depend on a header.

Reproducing this without Google credentials is easy, and worth knowing for any
future proxy question: start the production build with dummy client id/secret
and read the `Location` header of `/auth/google` — the redirect leg never
contacts Google, so the derived `redirect_uri` is right there in the 302.

```bash
curl -sD - -o /dev/null -H 'Host: example.com' http://localhost:3000/auth/google | grep -i location
```

**Not tested:**

- **Camera barcode scanning.** Uses the native `BarcodeDetector` API (no
  scanning library). Unavailable in Safari, hence manual entry alongside. The
  lookup API behind it is tested; the camera path is not.
- **Real iOS/Android devices.** Only a 390×844 headless Chromium viewport.

---

## 7. Known gaps, if you're looking for work

- No service worker — the manifest makes it installable, not offline-capable.
- Friend requests are **polled**, not pushed: the prompt in the layout asks
  `/api/friends/pending` on load and every two minutes. Fine for a household;
  it is not a notification system, and there is no email.
- Nothing tells a friend that you *changed* what you share — the door simply
  closes. A note on their page would be kinder than a tab quietly disappearing.
- A friend's page shows their diary a day at a time with no summary; there is no
  way to compare two people's weeks side by side, which is the obvious next
  thing to want from a family tracker.
- Invite links can't be addressed to a person, so anyone who gets hold of one
  can use it, and now more than one person can use the *same* link. It expires
  in 30 days (`INVITE_TTL_DAYS`) and the inviter can cancel it, which is the
  whole mitigation.
- 34% of foods have no `serving_grams`; the portion picker falls back to 100 g.
- Water "undo" subtracts a preset amount rather than removing the last entry.
- No macro trends — Trends charts calories and weight only.
- The calorie target is set once and never revisited; nothing nudges you when
  your actual rate of loss diverges from the plan you stored.
- No meal copying or "log yesterday again".
- The ingredient parser gives a bare count ("2 large eggs", "1 garlic clove")
  0 g and a note, because there is no per-egg weight to look up. A small table
  of typical unit weights would resolve most of them.
- Volume of a non-liquid food converts at 1 ml = 1 g. Right for water, ~8% low
  for oil, ~45% high for flour. The portion label is stored alongside so the
  assumption is visible and one tap from being fixed, but a density table for
  the dozen things people actually measure by cup would be better.
- Nothing re-runs the matcher over old unresolved lines when the food library
  grows, and there is no "try again" button.
- The URL importer has no JavaScript engine, so a recipe rendered client-side
  is invisible to it. The paste tab is the fallback, but nothing tells the user
  that in so many words.
- A nested recipe is re-totalled through its ancestors on every edit, which is
  fine at household scale and is a full walk per mutation. If someone builds a
  hundred-recipe web it wants a dirty flag instead.
- A frozen meal keeps the name it was logged under, so renaming a recipe to fix
  a typo leaves the old spelling in the diary. Defensible — it is a record —
  but propagating a rename to that recipe's snapshots is a one-liner if it
  grates.
- A logged recipe's *breakdown* still reads its ingredient foods live, so
  editing a custom food changes what a past meal is shown to have been made of.
  The meal's own calorie figure is frozen and does not move. Same trade the app
  has always made for a plain custom food.
- A custom food that has been logged still can't be deleted (409). Archiving
  would be kinder. Recipes no longer have this problem — they are frozen when
  logged.
- `data/` is gitignored — the 79 MB database does not travel via git. A fresh
  clone must run `node scripts/import-off.mjs` (~2 min).
- `scripts/reset-user-data.mjs` strips personal data while keeping the food
  library, for handing over a clean database.

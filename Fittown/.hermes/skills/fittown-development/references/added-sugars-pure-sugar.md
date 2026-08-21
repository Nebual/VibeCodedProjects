# Added sugars for pure sugars — the shared rule

## The rule

A product that **IS sugar** (not merely *contains* sugar) has no intrinsic sugar, so
every gram of its total sugars is an added sugar:

```
added_sugars_g = sugars_g   (only when isPureAddedSugar && sugars_g >= PURE_SUGAR_MIN_SUGARS)
```

This matters because Open Food Facts and USDA (both Foundation and Branded) frequently
omit `added_sugars` for the sugar aisles — the USDA Foundation dataset records nutrient
1235 almost never, so a bag of "Sugars, granulated" used to come out with added-sugars
"unknown" even though it is nothing but added sugar.

## Where it lives

`scripts/lib/pureSugar.mjs`:

- `isPureAddedSugar(categories, name) -> bool`
- `PURE_SUGAR_MIN_SUGARS = 85` (the g/100g total-sugars floor)

Shared by (so the three can't drift on what counts):

1. `scripts/import-off.mjs` — nutrient loop, when `raw === null` and `pureAddedSugar`
   and `totalSugars` set, uses totalSugars for `added_sugars_g`.
2. `scripts/import-usda-foundation.mjs` — same fallback; previously a **hardcoded
   `PURE_ADDED_SUGAR_IDS` set of two FDC ids** (334247, 746784 = 'Sugars, granulated').
   Generalised to the shared rule so a future FDC release adding another pure sweetener
   (brown/powdered/turbinado sugar, ...) is caught without a code change.
3. `scripts/fix-added-sugars.mjs` — the backfill (below).

It lives under `scripts/lib/` (not `#shared/`) because only the plain-`node` scripts
reach it. `test/pure-sugar.test.ts` locks the classification; run with
`node_modules/.bin/vitest run test/pure-sugar.test.ts`.

## What the rule refuses (the definitional edge cases)

These sit under OFF's "Sweeteners > Sugars" umbrella or end their name in "sugar" but
must NOT be treated as pure added sugar:

- **Zero-/no-calorie sweeteners** — stevia, monk fruit, erythritol, allulose, xylitol,
  sucralose, Splenda, aspartame, acesulfame; name tokens `zero/no/0 calorie`,
  `sweetener`, `sugar free`, `blend`, `naturally sweet`, `rancher`. OFF files these in
  the same "Sweeteners,Sugars" category as real sugar, so a pure category match alone is
  not enough.
- **Single-ingredient syrups/pastes** — honey, maple syrup, molasses, agave, jam, jelly,
  preserves (regulators treat these differently from refined sucrose).
- **Foods that merely contain sugar** — candy, gum, wafers, cookies, hot-cocoa mix,
  glazes, "Ham Glaze, Maple Brown Sugar", "X Stirred With Sugar", "Rose petals with
  sugar", marshmallow, fruit preserves, etc.

**Always gate on the total-sugars floor too.** A product named "Sugar" that reports
20 g/100g total sugars is a data error, not a pure sweetener; copying it across would
wrongly claim 20 g added. Genuine sugars run ~100 g (brown 100, powdered 96.7,
coconut ~85). The floor is what excludes most "X with sugar" fruit products (~50 g).

## Why a backfill script is the right shape

An importer-only fix helps fresh imports but not a database already imported. Fittown's
convention (see `recompute-recipes.mjs`, `snapshot-diary-recipes.mjs`, both importers) is a
one-off catch-up script that:

1. resolves the path from `process.argv` or `FITTOWN_DB_PATH`, default `data/fittown.db`;
2. opens with `DatabaseSync`, sets `busy_timeout`;
3. calls `ensureSchema(db)` then `PRAGMA foreign_keys = ON` — **required**, because the
   app applies `ADDED_COLUMNS` lazily and a never-served DB is missing later columns;
4. filters rows with the SAME shared rule + floor as the importers (never a second copy
   of the logic — two implementations drift, and the wrong one is the one nobody watches);
5. supports `--dry` to preview and count before writing;
6. wraps the write in a transaction (`BEGIN`/`COMMIT`, `ROLLBACK` on error).

`--dry` also makes these scripts the best probe for validating a classification rule
against the real DB **before** writing the JS: iterate the heuristic in Python against
a read-only sqlite3 open of `data/fittown.db`, eyeball the candidate rows for false
positives, tighten the rule, then confirm the JS script reproduces the same count.

## 2026-08 session result

`fix-added-sugars.mjs` found and fixed **492** rows across the live DB
(56 OFF + 436 USDA Branded; USDA Foundation had none missing — its only pure sugar is
"Sugars, granulated", already set). False-positive traps that emerged while tuning the
rule: `\bberries\b` doesn't match compound words like "Lingonberries" (so gate on the
sugars floor, not the word); the `NON_PURE`/`ARTIFICIAL` regexes must be `\b`-word-bound
alternations; "X with/and/in sugar" phrasing must be refused as an ingredient, not the
product identity.

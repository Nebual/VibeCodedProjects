# Adding a user-configurable nutrient limit goal (e.g. Added Sugars)

Verified end-to-end when wiring a Sugar (added-sugar) limit into Fittown. This is
the class of "render a nutrient as a % of a per-user goal" feature. It touches
the same files every time; the order below is the dependency order.

## The two "100%-full" integration points

**1. `shared/nutrients.ts` decides whether a nutrient renders as a limit.**
A row shows a `limit` tag + red-overrun bar only if its `NutrientDef` has
`limit: true` (and an `rda` for the fixed fallback). `added_sugars_g` already had
`{ rda: 50, limit: true }` — so it *already* rendered as a budget, just against
the hardcoded 50 g Daily Value. If your nutrient isn't flagged `limit`, it will
render as a "target" (green at 100%) instead — wrong for anything it's safer to
undershoot. Add the flag in the catalogue.

**2. `app/components/NutrientBreakdown.vue` — `targetFor(key, fallback)` is the
single knob.** It maps a nutrient key to a per-user goal:
```ts
const overrides: Record<string, number> = {
  protein_g: goals.protein_g, carbs_g: goals.carbs_g, fat_g: goals.fat_g,
  fiber_g: goals.fiber_g,
  added_sugars_g: goals.sugar_limit_g,   // <- add your key here
}
return overrides[key] ?? fallback         // fallback = the catalogue rda (fixed DV)
```
The `%` is `value / target * 100` and the bar colour comes from `barClass(limit,
pct)`. That one override is the whole server-less logic.

## The trap: every use of <NutrientBreakdown> must pass :goals

`goals` is an **optional prop**. Miss a call site and the nutrient silently falls
back to the fixed DV — looks correct, isn't. Grep ALL usages:

- `app/pages/index.vue` (diary day) — passes `:goals="day.goals"` already.
- `app/pages/food/[id].vue` — already fetches `/api/goals` as `settings` for the
  unit pref; reuse `:goals="settings?.goals"`, no new request.
- `app/pages/recipes/[id].vue` — add `const { data: goalsData } = await
  useFetch<{goals: Goals}>('/api/goals')` + `useFetch` a `Goals` type import.
- `app/components/RecipeReadOnly.vue` — add optional `goals?: Goals` prop, pass
  it through to its breakdown. Its parents: the signed-in friends page
  (`friends/[id]/recipes/[recipeId].vue`) fetches `/api/goals` too; the
  **signed-out public link (`r/[token].vue`) must NOT** — `/api/goals` 401s
  there, so leave it unset and let it fall back to the fixed DV.

Every signed-in surface should render against *the viewer's own* goals (the
`/api/goals` response is always the requester's row), not some owner's.

## Settings UI: storing the goal + a percentage governor

- `server/db/schema.ts` `user_goals` (fresh DBs) **and** `server/utils/db.ts`
  `ADDED_COLUMNS` (existing DBs) — the two-edit rule. Add a comment naming the
  default (e.g. `sugar_limit_g REAL NOT NULL DEFAULT 50` = 10% of 2000 kcal,
  sugar ≈ 4 kcal/g).
- `server/api/goals/index.put.ts` — add to `NUMERIC_GOALS` with a sane
  min/max range (out-of-range → 400, verified by HTTP smoke test).
- `app/composables/useDiary.ts` — add the field to the `Goals` interface.
- `app/pages/settings.vue` uses `goalFields` for the plain numeric rows (calorie
  / fiber / water). The sugar field was hand-built instead to host inline
  preset buttons (`10%` / `5%`) that re-derive grams from the calorie goal
  (`grams = round(calories * pct/100 / 4)`). If you replace `goalFields`, keep
  calorie, fibre and water in the same grid.

**"Follow the plan" coupling:** the calorie-target modal's `applyPlan()` updates
calorie/macros/water. If a sugar-style limit is set to one of the % presets
(relative to the *old* calories, tolerant of gram rounding), re-derive it at the
same % of the *new* calories; a hand-set gram value matching no preset is left
alone. `sugarPercentOf(calories, grams)` does the tolerant preset match.
Mirror this for any future goal that is defined as a percentage of the calorie
budget.

**Displaying what a goal calculates to:** under the sugar field, if the grams
match a preset the matching `10%`/`5%` button is underlined (class binding
`:class="{ 'underline …': sugarCurrent?.preset === p }"`); otherwise a faint
`= 3.3%` caption shows `grams * 4 / calories`, trimmed to 1 dp.

## Importer + existing-data backfill for a food-mapped nutrient

`added_sugars_g` maps to USDA FDC nutrient 1235, but Foundation Foods rarely
records it — so pure added sweeteners (e.g. 'Sugars, granulated', FDC ids
334247/746784) imported with `sugars_g=99.8` and `added_sugars_g=NULL`. For a
food that is *nothing but* added sweetener, total sugars ARE the added sugars:
in `scripts/import-usda-foundation.mjs` add a `PURE_ADDED_SUGAR_IDS` set keyed on
`fdc_id` and fall back `added_sugars_g <- sugars_g` when 1235 is absent. This is
an honest value, not an invented one — it respects `null ≠ zero`.

Changing an importer only affects the *next* run. To fix the shipped DB today,
run a one-off UPDATE over the existing `source='usda_foundation'` rows matching
those fdc_ids (`added_sugars_g = sugars_g WHERE added_sugars_g IS NULL AND
sugars_g IS NOT NULL`). Backed by the upsert on `(source, barcode)` this stays
idempotent across re-imports and preserves food-id integrity. Verify the backfill
with `SELECT id,barcode,name,sugars_g,added_sugars_g`.

## Verification recipe

1. `node_modules/.bin/vitest run` (Node ≥ 24).
2. `node_modules/.bin/nuxi build` — catches any missed `Goals` import / prop type.
3. HTTP smoke on a throwaway DB: GET `/api/goals` shows the default (2000/50),
   PUT persists a changed value, an out-of-range PUT returns 400.
4. Copy the real `data/fittown.db` and call `ensureSchema()` on the copy to
   confirm the new column migrates onto an existing DB (lazy on boot), then
   confirm the backfilled food rows survived.

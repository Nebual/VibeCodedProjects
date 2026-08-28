# Nutrients, units & the timezone — full reasoning

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

**Units are display-only, everywhere.** kg for weight, cm for height, ml for
volume, grams for portions — always, whatever the user typed. `shared/body.ts`
and `shared/portions.ts` own every conversion; if you find a `* 2.20462` in a
component, move it. Food and body measurements have *separate* preferences
(`food_system` vs `weight_unit`/`height_unit`) because Canadian households
routinely weigh food in grams and themselves in pounds.

**`portion_default` is a third, orthogonal preference**: `'serving' | 'g' |
'100g'` — which *kind* of portion a picker opens on, where `food_system` only
says which weight unit. It decides the opening selection in
`usePortionOptions()` and nothing else; a portion already logged still wins
over it, and a recipe with no weighed yield still opens on a serving, because
`showsGramPortions()` says the app has no grams it is entitled to quote.

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

## Pure added sugar (single shared rule)

**A pure added sugar's added-sugars equals its total sugars.** A product that
*is* sugar (granulated/brown/powdered/icing/turbinado/demerara cane sugar,
sucanat, sugar cubes, ...) has no intrinsic sugar, so its `added_sugars_g`
should equal its `sugars_g`. OFF and USDA frequently omit added-sugars for
exactly these (USDA Foundation never records nutrient 1235), so the importers
fall back to total sugars — gated by `isPureAddedSugar()`
(`scripts/lib/pureSugar.mjs`, shared by both importers *and* the backfill so
they can't drift) **plus** a ≥ `PURE_SUGAR_MIN_SUGARS` (85 g/100 g) total-sugars
floor. Zero-/no-calorie sweeteners (stevia, monk fruit, erythritol, Splenda),
single-ingredient syrups (honey, maple, molasses, agave) and foods that merely
*contain* sugar (candy, gum, wafers, hot-cocoa mix, glazes, fruit-and-sugar
preserves) are deliberately excluded. The USDA Foundation importer used to do
this with two hardcoded FDC ids for 'Sugars, granulated'; it now calls the same
helper. `scripts/fix-added-sugars.mjs` applies exactly this to an
already-imported database (default `data/fittown.db`, or pass a path /
`--dry` to preview) — run it after a re-import if you want the same guarantee
the importers now give fresh rows.

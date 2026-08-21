# Layout, schema & stack

## Stack

Nuxt 4, Tailwind v4 (`@tailwindcss/vite`, no config file), DaisyUI 5
(configured in `app/assets/css/main.css` via `@plugin`), `nuxt-auth-utils`,
`node:sqlite` (built into Node 24 — **no native module**, don't add
`better-sqlite3`).

## Layout

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

## Schema as a template literal

`server/db/schema.ts` is a TS template literal rather than a `.sql` file so
bundling is deterministic in production. Applied idempotently on every boot.

## The `#shared/*` imports map

`package.json` carries an `imports` map for `#shared/*`, mirroring the alias
Nuxt sets up. It exists so the plain-`node` scripts in `scripts/` can import the
app's own modules — `recompute-recipes.mjs` runs the same `recomputeRecipe()`
the API does instead of keeping a second copy of the arithmetic. Node resolves
ESM specifiers literally, so imports reached that way need their `.ts`
extension (`./foods.ts`); Nuxt, Vite and Vitest are all happy with it.


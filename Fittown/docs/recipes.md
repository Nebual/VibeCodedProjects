# The recipe system — full reasoning

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

## An ingredient may have no food, and 0 g is a real amount

Both come from the recipe importer. A pasted or scraped line the matcher can't
identify with confidence is stored as text — `recipe_ingredients.food_id` is
**nullable**, with `raw_text` carrying the line — rather than being guessed at
or turned into a nutrition-less placeholder food. A line with no numeric amount
("pinch of salt", "a lot of oregano") is stored at 0 g with the descriptor in
`note`. Three consequences worth knowing before you touch this code:

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

## A logged recipe is frozen

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

## An ingredient can be optional (two flags)

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

## A meal's adjustments land on the frozen copy, never on the recipe

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

## Reordering takes the whole list

`PATCH /api/recipes/[id]/ingredient-order` sends every ingredient id, and
`reorderIngredients()` refuses anything else — compared as **sets**, so a
duplicate id is caught too (`[7, 7]` against two rows has the right length and
would leave one row where it was). A client working from a stale copy would
otherwise scramble the rows it didn't know about, and the rows it did send would
look right. The path is deliberately not `ingredients/order`, which would sit
beside `[ingredientId].patch.ts` and depend on static-beats-dynamic routing not
to be read as an ingredient called "order".

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

## Variants are a flat family, keyed by `recipe_family_id`

Every member holds the id of whichever of them was created first — set on insert
in `createRecipeFood()`, because the id doesn't exist until the row does, and
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

## A recipe may contain another recipe (nesting)

The ingredient's `food_id` points at a `foods` row with `source = 'recipe'`; the
arithmetic needs nothing new, because a recipe already carries real per-100 g
values. Three rules keep this from going wrong:

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

## Portions, matching and scraping

**"No yield, no grams" now applies to ingredient rows too.** `portionText()`
drops the gram gloss beside "1 × serving" of a recipe nobody weighed — the
weight behind it is what went *into* the batch. It keeps the figure when there
is no named portion to show instead, because then it is the only amount on the
row. And `showsGramPortions()` in `shared/recipes.ts` is the one rule, used by
the portion picker, the diary and the search results: a recipe nobody weighed is
measured in servings only; its internal basis is what went *into* the pot, and
quoting that as the weight of a dish that spent an hour boiling down would be
inventing a number.

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

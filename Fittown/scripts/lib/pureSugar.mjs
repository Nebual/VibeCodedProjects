/**
 * Whether a food is a *pure added sugar* — a product that IS sugar, so its
 * entire sugar content is added sugar by definition.
 *
 * Shared by the OFF and USDA Foundation importers and the
 * `fix-added-sugars.mjs` backfill so the three can't drift on what counts.
 * The USDA Foundation importer previously hardcoded two FDC ids ('Sugars,
 * granulated'); this is the generalised, forward-looking version of that
 * same call.
 *
 * The distinguishing idea: sugar is "pure" when the product *is* the sugar —
 * the leading/terminal noun is a sugar, or (for OFF, whose categories are
 * reliable) its terminal category is a sucrose sugar type — and it is NOT a
 * multi-component food that merely happens to contain sugar.
 *
 * Deliberately EXCLUDED (not "added sugar" for our purposes):
 *   - zero-/no-calorie sweeteners (stevia, monk fruit, erythritol, allulose,
 *     xylitol, sucralose, Splenda, aspartame, ...) — they have no sucrose;
 *   - single-ingredient syrups/pastes (honey, maple syrup, molasses, agave,
 *     jam, jelly, preserves) — regulators treat these differently;
 *   - foods that merely CONTAIN sugar (candy, gum, wafers, cookies, hot
 *     cocoa mix, glazes, fruit preserves, etc.).
 *
 * Even so, the CALLER must also require a high total-sugars value
 * (`PURE_SUGAR_MIN_SUGARS`) before applying the fallback — a product whose
 * name is "Sugar" but that reports 20 g/100 g total sugars is a data error,
 * not a pure sweetener, and copying it across would wrongly claim 20 g added.
 */
const SUCROSE_TERMINAL = new Set([
  'Sugars', 'Sugar', 'White sugars', 'Brown sugars', 'Granulated sugars',
  'Icing sugar', 'Powdered sugar', 'Confectioner sugar', 'Caster sugar',
  'Demerara sugars', 'Muscovado sugars', 'Turbinado sugars', 'Raw sugars',
  'Lump sugar', 'Beet sugars',
])

/**
 * OFF files zero-calorie sweeteners (stevia, monk fruit, ...) under the same
 * "Sweeteners > Sugars" umbrella as real sugar, so a pure category match is
 * not enough on its own — these names must veto it.
 */
const ARTIFICIAL_SWEETENER =
  /\b(stevia|monk|erythritol|allulose|xylitol|sucralose|splenda|aspartame|acesulfame|saccharin|zero\s*calorie|no\s*calorie|0\s*calorie|sweetener|sugar\s*free|sugar-free|no\s*sugar|blend|naturally\s*sweet|rancher)\b/i

/**
 * Multi-component foods whose name happens to end in "sugar" (or that contain
 * sugar) must not be treated as pure sugar: gum, wafers, hot cocoa mix,
 * brown-sugar glazes, fruit-and-sugar preserves, marshmallow peeps, etc.
 * "sugar as an ingredient" phrasing (X with/and/in sugar) is refused too —
 * there the product is the other thing, not the sugar.
 */
const NON_PURE =
  /\b(candy|candies|gum|wafers?|cookie|cookies|crunch|crunchy|crackl|chocolat|cocoa|mix\b|bar\b|bars|bites|roll|wands|granola|cereal|crust|cluster|flakes|treats?|pieces?|bits|crisp|frosted|shake|smoothie|syrup|honey|molasses|agave|jam|jelly|preserve|puff|puffs|marshmallow|figurine|petal|glaze|thai|berry|berries|currant|bark|ham\b|fruit|leaves|leaf|teas?|coffee|cake|pie|chew|taffy|caramel|frosting|dip|sauce|with\s+sugars?|and\s+sugars?|in\s+sugars?|containing\s+sugars?)\b/i

/** Product name that IS a sugar: "... sugar", "sugar, <type>", etc. */
const NAME_END =
  /\b(white|brown|light\s*brown|dark\s*brown|cane|granulated|powdered|confectioners?|icing|turbinado|demerara|muscovado|raw|pure|extra\s*fine|fine|table|crystal|rock|sanding|decorating)?\s*sugars?\s*$/i

/** USDA-style leading-noun names: "Sugars, granulated", "Sugar, powdered". */
const NAME_COMMA =
  /^sugars?\s*,\s*(granulated|white|brown|table|powdered|confectioners?|turbinado|raw|sucanat)/i

/**
 * A caller should only apply the added-sugars fallback when a product's total
 * sugars reach this floor — a genuine pure sweetener is ~100 g/100 g (brown
 * sugar 100, powdered 96.7, coconut ~85), while a multi-component food that
 * merely touched sugar sits well below it.
 */
export const PURE_SUGAR_MIN_SUGARS = 85

/** Whether a product, by category and name alone, is a pure added sugar. */
export function isPureAddedSugar(categories, name) {
  if (!name) return false
  if (ARTIFICIAL_SWEETENER.test(name)) return false

  // OFF's terminal category is the reliable signal for pure sucrose sugars
  // (and captures non-English names like "Sucre en cube", "Raffinade Zucker").
  if (categories) {
    const terminal = String(categories).split(',').pop().trim()
    if (SUCROSE_TERMINAL.has(terminal)) return true
  }

  // Otherwise the name must literally be sugar (USDA Foundation/Branded).
  if (NON_PURE.test(name)) return false
  return NAME_COMMA.test(name) || NAME_END.test(name)
}

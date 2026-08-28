/**
 * Portion units for logging food.
 *
 * Nutrition is stored per 100 g (or per 100 ml for liquids), so every portion
 * a user can pick has to resolve to a number of grams/millilitres before it
 * touches the database. This table is that conversion, in one place, so the
 * label you tapped and the grams that get stored can never drift apart.
 *
 * A household doesn't use one unit for everything — a recipe says 8 oz of
 * chicken and 200 g of flour in the same breath — so the unit is chosen per
 * entry. The settings preference only decides which one is selected first.
 */

export type MeasurementSystem = 'metric' | 'imperial'

export interface PortionUnit {
  key: string
  /** Shown in the picker. */
  label: string
  /** Base units (g for solids, ml for liquids) in one of these. */
  size: number
}

/** Grams. Definitions are exact: the avoirdupois ounce and pound. */
export const MASS_UNITS: PortionUnit[] = [
  { key: 'g', label: 'g', size: 1 },
  { key: '100g', label: '100 g', size: 100 },
  { key: 'oz', label: 'oz', size: 28.349523125 },
  { key: 'lb', label: 'lb', size: 453.59237 },
  { key: 'kg', label: 'kg', size: 1000 },
]

/**
 * Millilitres. The US fluid ounce and its cup (8 fl oz), since the food
 * database is a US + Canada import — a UK fl oz is 28.4 ml and a metric cup
 * 250 ml, which is exactly the kind of quiet 4% error worth not introducing.
 */
export const VOLUME_UNITS: PortionUnit[] = [
  { key: 'ml', label: 'ml', size: 1 },
  { key: '100ml', label: '100 ml', size: 100 },
  { key: 'floz', label: 'fl oz', size: 29.5735295625 },
  { key: 'cup', label: 'cup', size: 236.5882365 },
  { key: 'l', label: 'L', size: 1000 },
]

export const portionUnits = (isLiquid: boolean) => (isLiquid ? VOLUME_UNITS : MASS_UNITS)

/** The base unit everything resolves to, for labels. */
export const baseUnit = (isLiquid: boolean) => (isLiquid ? 'ml' : 'g')

/**
 * Which unit a picker should start on.
 *
 * Imperial defaults to oz / fl oz rather than lb: a portion of food is far
 * more often measured in ounces, and someone weighing out 0.3 lb of chicken is
 * doing arithmetic the app should have done for them.
 */
export function defaultUnitKey(system: MeasurementSystem, isLiquid: boolean): string {
  if (system === 'imperial') return isLiquid ? 'floz' : 'oz'
  return isLiquid ? 'ml' : 'g'
}

/**
 * What a portion picker opens on, when the food doesn't force the answer.
 *
 * 'serving' is how the app has always behaved — the packet's own serving, or a
 * named portion of it — and stays the default. The other two are for people who
 * weigh everything: they'd rather land on the scale reading than on "1 serving"
 * of a figure someone else chose.
 */
export const PORTION_DEFAULTS = ['serving', 'g', '100g'] as const
export type PortionDefault = (typeof PORTION_DEFAULTS)[number]

/**
 * Which unit key a portion preference means for this food, or null for
 * 'serving' — which is not a unit at all, but "whatever this food calls one".
 *
 * Liquids get the millilitre of the same size, so a preference set once holds
 * for a bottle of milk as well as for a block of cheese.
 */
export function portionDefaultUnitKey(
  preference: PortionDefault,
  isLiquid: boolean,
): string | null {
  if (preference === 'serving') return null
  if (preference === '100g') return isLiquid ? '100ml' : '100g'
  return isLiquid ? 'ml' : 'g'
}

/**
 * A sensible starting amount for a freshly-selected unit.
 *
 * Switching to "g" and seeing `1` in the box is useless; so is switching to
 * "lb" and seeing `100`. Aim for something in the region of a real portion.
 */
export function defaultAmount(unit: PortionUnit): number {
  if (unit.size >= 400) return 0.5 // lb, L — half a pound of mince, half a litre
  if (unit.size >= 90) return 1 // 100 g, 100 ml, cup
  if (unit.size > 1) return 4 // oz, fl oz
  return 100 // straight grams / millilitres
}

/**
 * Units that turn up in written recipes, for the bulk/URL importer.
 *
 * Deliberately a separate table from `MASS_UNITS` / `VOLUME_UNITS`, which are
 * the *portion picker's* lists and are short on purpose. A recipe says
 * "2 tbsp olive oil" and nobody logs a meal in tablespoons, so adding these
 * there would clutter every portion dropdown in the app to serve one parser.
 *
 * `size` is in base units — grams for mass, millilitres for volume — which is
 * what `recipe_ingredients.grams` stores either way. That is also why a volume
 * of a food measured per 100 g resolves 1:1: without a density we would be
 * inventing a number, and the label rides along on the row so the user can see
 * the assumption and correct it.
 *
 * US definitions throughout, matching `VOLUME_UNITS` — the food library is a
 * US + Canada import, and a UK fluid ounce would be a quiet 4% error.
 *
 * Aliases are matched longest-first and case-insensitively, with two exceptions
 * handled by the parser: a bare `T` is a tablespoon and a bare `t` a teaspoon.
 */
export interface RecipeUnit extends PortionUnit {
  /** Base units are millilitres rather than grams. */
  volume: boolean
  /** Every spelling seen in the wild, lowercase. */
  aliases: string[]
}

export const RECIPE_UNITS: RecipeUnit[] = [
  { key: 'g', label: 'g', size: 1, volume: false,
    aliases: ['g', 'gr', 'gm', 'gram', 'grams'] },
  { key: 'kg', label: 'kg', size: 1000, volume: false,
    aliases: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'] },
  { key: 'mg', label: 'mg', size: 0.001, volume: false,
    aliases: ['mg', 'milligram', 'milligrams'] },
  { key: 'oz', label: 'oz', size: 28.349523125, volume: false,
    aliases: ['oz', 'ounce', 'ounces'] },
  { key: 'lb', label: 'lb', size: 453.59237, volume: false,
    aliases: ['lb', 'lbs', 'pound', 'pounds'] },

  { key: 'ml', label: 'ml', size: 1, volume: true,
    aliases: ['ml', 'cc', 'milliliter', 'milliliters', 'millilitre', 'millilitres'] },
  { key: 'cl', label: 'cl', size: 10, volume: true, aliases: ['cl'] },
  { key: 'dl', label: 'dl', size: 100, volume: true, aliases: ['dl'] },
  { key: 'l', label: 'L', size: 1000, volume: true,
    aliases: ['l', 'liter', 'liters', 'litre', 'litres'] },
  // Before `oz` is irrelevant (aliases are matched longest-first) but the
  // spelling with a space has to be listed explicitly or "fl oz" reads as "fl".
  { key: 'floz', label: 'fl oz', size: 29.5735295625, volume: true,
    aliases: ['fl oz', 'fl. oz', 'floz', 'fluid ounce', 'fluid ounces'] },
  { key: 'cup', label: 'cup', size: 236.5882365, volume: true,
    aliases: ['c', 'cup', 'cups'] },
  { key: 'tbsp', label: 'tbsp', size: 14.78676478125, volume: true,
    aliases: ['tbsp', 'tbsps', 'tbs', 'tb', 'tablespoon', 'tablespoons'] },
  { key: 'tsp', label: 'tsp', size: 4.92892159375, volume: true,
    aliases: ['tsp', 'tsps', 'teaspoon', 'teaspoons'] },
]

/** Round a gram figure the way a scale would: whole grams, tenths under 10 g. */
export function roundGrams(grams: number): number {
  return grams >= 10 ? Math.round(grams) : Math.round(grams * 10) / 10
}

/**
 * The amount — in a unit of `unitSize` base units — that reproduces
 * `targetGrams` as closely as the unit lets us, rounded to as few decimals as
 * remain honest.
 *
 * Used when switching portion types: the amount is re-expressed from a weight
 * that was already on screen, and re-expressing it should not add spurious
 * precision. 3 oz of something is 85.05 g; switching to grams and showing
 * "85.05 g" hides the point — 85 g is within a gram, so round to the nearest
 * gram. But never coarser than the weight deserves: "90 g" switching to oz
 * stays 3.2 oz (90.7 g), because 3 oz would be 85 g and that is 5 g off. A
 * small total (a ~15 g serving or less) needs a finer grain, where a whole
 * gram is a big fraction — there 0.1 g is the coarsest honest step.
 *
 * Never more than two decimals, whatever the conversion.
 */
export function portionAmount(targetGrams: number, unitSize: number): number {
  const exact = targetGrams / unitSize
  // A small total keeps a tenth of a gram; anything bigger can fall back to
  // whole grams where the tolerance allows.
  const coarsest = targetGrams > 15 ? 0 : 1
  for (let decimals = coarsest; decimals <= 2; decimals++) {
    const factor = 10 ** decimals
    const rounded = Math.round(exact * factor) / factor
    if (Math.abs(rounded * unitSize - targetGrams) <= 1) return rounded
  }
  return Math.round(exact * 100) / 100
}

/** "2 × oz = 57 g" — the sentence that makes a non-base unit trustworthy. */
export function conversionText(
  amount: number,
  unit: PortionUnit,
  isLiquid: boolean,
): string {
  const total = roundGrams(amount * unit.size)
  return `${amount} × ${unit.label} = ${total} ${baseUnit(isLiquid)}`
}

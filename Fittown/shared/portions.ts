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

/** Round a gram figure the way a scale would: whole grams, tenths under 10 g. */
export function roundGrams(grams: number): number {
  return grams >= 10 ? Math.round(grams) : Math.round(grams * 10) / 10
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

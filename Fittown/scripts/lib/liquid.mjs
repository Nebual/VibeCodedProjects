/**
 * Whether a product should be measured in millilitres rather than grams.
 *
 * Shared by the importer and the backfill script so the two can't drift.
 *
 * Categories are the reliable signal, but 62% of OFF rows have none, so the
 * product name is used as a fallback. The name test only accepts a liquid word
 * in *final* position ("Mango Sparkling Water", "Orange Juice") — matching
 * anywhere would classify "Milk Chocolate" and "Tea Biscuits" as drinks.
 */

const LIQUID_CATEGORY =
  /\b(beverages?|drinks?|waters?|juices?|sodas?|milks|coffees|teas|smoothies|lemonades|nectars|wines?|beers?|ciders?|spirits)\b/i

/**
 * OFF's category lists start with broad umbrella terms, and one of the most
 * common — "Plant-based foods and beverages" — contains the word "beverages"
 * while saying nothing about whether *this* product is drinkable. It sits on
 * oats, olive oil and most produce, so it has to be discarded before matching.
 */
const UMBRELLA_CATEGORY = /foods?\s+and\s+beverages/i

function meaningfulCategories(categories) {
  return String(categories)
    .split(',')
    .filter((c) => !UMBRELLA_CATEGORY.test(c))
    .join(',')
}

// Trailing size/pack suffixes are stripped before the final word is examined.
const TRAILING_NOISE = /[\s,(-]*\b[\d.]+\s*(fl\.?\s*oz|oz|ml|l|litres?|liters?|pack|ct|count)\b.*$/i

const LIQUID_NAME_TAIL =
  /\b(water|juice|soda|cola|lemonade|smoothie|kombucha|seltzer|beer|wine|cider|milk|coffee|tea|drink|ale|latte|espresso)s?\s*$/i

export function isLiquid(categories, name) {
  if (categories && LIQUID_CATEGORY.test(meaningfulCategories(categories))) return 1
  if (!name) return 0
  const trimmed = String(name).replace(TRAILING_NOISE, '').trim()
  return LIQUID_NAME_TAIL.test(trimmed) ? 1 : 0
}

/**
 * Which imported foods count toward the day's water goal.
 *
 * `is_liquid` only means "measured per 100ml" — it's just as true of cooking
 * oil and vinegar as it is of milk. Real separation comes from `categories`,
 * which OFF and USDA Branded already populate for ~95% of liquid rows (e.g.
 * "Beverages,Carbonated drinks,Sodas", "Dairies,Milks,Whole milks",
 * "Vinegars/Cooking Wines"), so a keyword match is enough — no new tag or
 * classifier needed.
 *
 * Deliberately excludes wine/beer/spirits as keywords: alcohol_g is a cleaner
 * signal (see below), and a category like "Vinegars/Cooking Wines" would
 * otherwise false-match on "wine".
 *
 * "dairy" is here for USDA Foundation Foods specifically: that source uses
 * USDA's old food-group taxonomy rather than OFF/Branded-style categories, so
 * fluid milk lands under "Dairy and Egg Products", not "Beverages" or
 * "Milks". Safe to include broadly — every `is_liquid=1` row under a "dairy"
 * category across the whole imported dataset is fluid milk; cheese, eggs and
 * yogurt in that same food group are all measured per-100g (`is_liquid=0`),
 * so they're excluded regardless of category text.
 */
const DRINK_CATEGORY_KEYWORDS = [
  'beverage', 'drink', 'milk', 'juice', 'tea', 'coffee',
  'soda', 'water', 'smoothie', 'kombucha', 'dairy',
]

/**
 * SQL expression computing one diary row's contribution to the day's water
 * goal, in ml. The query must alias `foods` as `f` and `diary_entries` as
 * `d` — `d.grams` is the logged amount, which is ml for an `is_liquid` food.
 *
 * Prefers the food's actual measured `water_g` when present (only ~2% of
 * liquid rows have it — mostly lab-analysed Foundation Foods — but it's free
 * accuracy). Otherwise defaults non-alcoholic drinks to 90%, roughly the
 * middle of what real beverages measure (milk ~88%, tea/soda ~99%+).
 *
 * Alcoholic drinks (`alcohol_g > 0`) contribute nothing — simpler and safer
 * than modelling the diuretic effect per drink, and it sidesteps needing
 * "beer"/"wine" as category keywords at all.
 */
export const HYDRATION_ML_SQL = `
  CASE
    WHEN f.is_liquid = 1
     AND COALESCE(f.alcohol_g, 0) <= 0
     AND (${DRINK_CATEGORY_KEYWORDS.map((k) => `f.categories LIKE '%${k}%'`).join(' OR ')})
    THEN d.grams * MIN(1.0, MAX(0.0, COALESCE(f.water_g, 90.0) / 100.0))
    ELSE 0.0
  END
`

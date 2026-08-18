import { parseIngredientLine } from '#shared/ingredientText'
import { roundGrams } from '#shared/portions'
import { isRecipe, showsGramPortions } from '#shared/recipes'
import type { RecipeIngredient } from '~/composables/useRecipes'

/**
 * How a recipe ingredient reads on screen.
 *
 * Shared by the editor and the read-only view so that a recipe looks the same
 * to the person who wrote it and the friend they sent it to — and so the
 * null-food case is handled once rather than in two components that would
 * otherwise both throw on an imported line.
 */

/** An unmatched line has no food row, so its pasted text is its name. */
export function ingredientName(ingredient: RecipeIngredient): string {
  return ingredient.food?.name ?? ingredient.raw_text ?? 'Unnamed ingredient'
}

/**
 * Is this ingredient another recipe?
 *
 * Worth saying on screen: "1 × serving" of a recipe means a share of something
 * that can change, where the same words against a jar of mustard mean a fixed
 * amount. The badge is also the only clue that tapping through leads to another
 * recipe rather than to a food.
 */
export function isNestedRecipe(ingredient: RecipeIngredient): boolean {
  return ingredient.food !== null && isRecipe(ingredient.food)
}

/** Has this line been matched to a food we can get nutrition from? */
export function isResolved(ingredient: RecipeIngredient): boolean {
  return ingredient.food !== null
}

/**
 * "1.5 × cup · 240 g", or just the amount, or nothing at all.
 *
 * A 0 g ingredient deliberately returns an empty string rather than "0 g": the
 * amount is unknown, not zero, and printing a measurement nobody took is the
 * same lie as `?? 0` on a nutrient.
 *
 * The gram gloss is dropped for a nested recipe nobody weighed — "1 × serving"
 * of a dressing is exact, and the weight behind it is what went *into* the
 * batch, not what came out of it. Same rule the portion picker and the diary
 * follow (`showsGramPortions`); this is the third place it applies. It is only
 * dropped when there is a named portion to show instead: with nothing else to
 * print, the amount the user actually typed beats saying nothing.
 */
export function portionText(ingredient: RecipeIngredient): string {
  const unit = ingredient.food?.is_liquid ? 'ml' : 'g'
  const amount = ingredient.grams > 0 ? `${roundGrams(ingredient.grams)} ${unit}` : ''
  const named = ingredient.serving_label && ingredient.serving_count

  if (named) {
    const count = Number(ingredient.serving_count!.toFixed(2))
    const portion = `${count} × ${ingredient.serving_label}`
    const mayQuoteWeight = !ingredient.food || showsGramPortions(ingredient.food)
    return amount && mayQuoteWeight ? `${portion} · ${amount}` : portion
  }
  return amount
}

/**
 * What to put in the search box when swapping this ingredient's food.
 *
 * The imported line is the best description of what the user meant, but it
 * can't be searched raw: full-text search prefix-matches every term with AND,
 * so "1/4c avocado oil" looks for something beginning "1", "4c", "avocado"
 * *and* "oil" and finds nothing. Running it back through the same parser the
 * import used strips the amount and the prep words and leaves "avocado oil".
 *
 * Falling back to the matched food's own name is deliberate but second choice:
 * for a wrong match like "Avocado Oil Cooking Spray" it carries the very words
 * that made it wrong, so the original line wins whenever we still have it.
 */
export function ingredientSearchTerm(ingredient: RecipeIngredient): string {
  const parsed = ingredient.raw_text ? parseIngredientLine(ingredient.raw_text) : null
  return parsed?.name || ingredient.food?.name || ingredient.raw_text || ''
}

/**
 * The muted second line: brand, amount and the importer's note, in that order.
 *
 * The note is what carries "a lot of" and "minced" through to the user, which
 * is the whole reason an unmeasurable ingredient is worth storing at all.
 */
export function ingredientDetail(ingredient: RecipeIngredient): string {
  // "not counted" rather than "optional": the badge beside the name already
  // says it is optional, and what this line has to answer is whether the
  // number on the right is in the total.
  const skipped = ingredient.is_optional && !ingredient.is_included ? 'not counted' : null
  return [ingredient.food?.brand, portionText(ingredient), ingredient.note, skipped]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' · ')
}

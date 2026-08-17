import { roundGrams } from '#shared/portions'
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
 */
export function portionText(ingredient: RecipeIngredient): string {
  const unit = ingredient.food?.is_liquid ? 'ml' : 'g'
  const amount = ingredient.grams > 0 ? `${roundGrams(ingredient.grams)} ${unit}` : ''

  if (ingredient.serving_label && ingredient.serving_count) {
    const count = Number(ingredient.serving_count.toFixed(2))
    const portion = `${count} × ${ingredient.serving_label}`
    return amount ? `${portion} · ${amount}` : portion
  }
  return amount
}

/**
 * The muted second line: brand, amount and the importer's note, in that order.
 *
 * The note is what carries "a lot of" and "minced" through to the user, which
 * is the whole reason an unmeasurable ingredient is worth storing at all.
 */
export function ingredientDetail(ingredient: RecipeIngredient): string {
  return [ingredient.food?.brand, portionText(ingredient), ingredient.note]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' · ')
}

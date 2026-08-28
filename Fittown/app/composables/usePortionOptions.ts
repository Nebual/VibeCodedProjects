import { computed, reactive, ref, watchEffect } from 'vue'
import {
  baseUnit,
  defaultAmount,
  defaultUnitKey,
  portionAmount,
  portionDefaultUnitKey,
  portionUnits,
  roundGrams,
  VOLUME_UNITS,
  type MeasurementSystem,
  type PortionDefault,
} from '#shared/portions'
import { showsGramPortions } from '#shared/recipes'
import type { FoodRow } from '~/composables/useDiary'

/**
 * The portion picker's logic, shared by the diary and the recipe editor.
 *
 * Both screens ask the same question — "how much of this?" — and both have to
 * answer it in grams, because grams are the only thing nutrient maths can use.
 * Keeping one implementation is what stops "2 × cup" meaning one amount in a
 * recipe and a slightly different one in the diary.
 */

export interface PortionOption {
  key: string
  label: string
  /** Base units (g or ml) in one of these. */
  size: number
  /** 'base' portions are logged as a plain weight, with no "2 × oz" label. */
  kind: 'serving' | 'unit' | 'base'
}

/** A named portion attached to a food, e.g. "1 slice" = 28 g. */
export interface FoodServing {
  id: number
  label: string
  grams: number
}

/** What both the diary and a recipe ingredient store. */
export interface PortionSelection {
  grams: number
  serving_label: string | null
  serving_count: number | null
}

/**
 * Does this label already state a size? Open Food Facts serving text usually
 * does — "5.3 ONZ (150 g)" — and appending our own would give "(150 g) (150 g)".
 */
const STATES_SIZE = /\d\s*(g|ml|kg|l)\b/i

/** Does a serving already on the list state its own cup size, e.g. "1 cup" or "0.5 cup chopped"? */
const STATES_CUP = /\bcups?\b/i

/**
 * A solid food has no cup of its own — a cup of flour and a cup of rice aren't
 * the same weight — but a cup is still how most people measure by hand, and
 * making everyone reach for a scale instead is worse than an estimate. Falls
 * back to the same 1 g-per-ml assumption the recipe-line parser uses for a
 * volume with no stated density (`RECIPE_UNITS` in `shared/portions.ts`), and
 * only when the food doesn't already define a cup-sized serving of its own.
 */
const FALLBACK_CUP = VOLUME_UNITS.find((u) => u.key === 'cup')!

export function usePortionOptions(
  food: Ref<FoodRow | undefined | null>,
  servings: Ref<FoodServing[]>,
  system: Ref<MeasurementSystem>,
  initial?: Ref<PortionSelection | null | undefined>,
  portionDefault?: Ref<PortionDefault>,
) {
  const isLiquid = computed(() => !!food.value?.is_liquid)
  const unit = computed(() => baseUnit(isLiquid.value))

  /**
   * May we offer grams, ounces and the rest?
   *
   * No, for a recipe nobody weighed: its internal basis is the raw ingredient
   * sum, which is what went *into* the pot, so "100 g of chili" would overstate
   * a dish that spent an hour boiling down. Servings stay exact either way.
   */
  const showsGrams = computed(() => (food.value ? showsGramPortions(food.value) : true))

  /**
   * The product's own serving first, then any named portions, then the generic
   * units. Order matters: the first entry is what a fresh picker lands on, and
   * for a recipe that is deliberately "1 serving".
   */
  const options = computed<PortionOption[]>(() => {
    const list: PortionOption[] = []
    const f = food.value
    if (!f) return list

    if (f.serving_grams) {
      list.push({
        key: 'serving',
        label: f.serving_size_text?.trim() || 'serving',
        size: f.serving_grams,
        kind: 'serving',
      })
    }
    for (const serving of servings.value) {
      list.push({ key: `s${serving.id}`, label: serving.label, size: serving.grams, kind: 'serving' })
    }
    if (showsGrams.value) {
      for (const u of portionUnits(isLiquid.value)) {
        list.push({
          key: `u:${u.key}`,
          label: u.label,
          size: u.size,
          kind: u.size === 1 ? 'base' : 'unit',
        })
      }
      // Liquids already got a cup above, from VOLUME_UNITS. Solids don't — add
      // the estimate, unless a serving already on the list states its own.
      if (!isLiquid.value && !list.some((o) => o.kind === 'serving' && STATES_CUP.test(o.label))) {
        list.push({ key: 'u:cup', label: FALLBACK_CUP.label, size: FALLBACK_CUP.size, kind: 'unit' })
      }
    }
    return list
  })

  const selectedKey = ref<string>('')
  const amount = ref(1)

  watchEffect(() => {
    if (!food.value || selectedKey.value || options.value.length === 0) return

    // Re-opening something already logged: land on the portion it was logged
    // with, so "2 × cup" reads back as 2 × cup rather than 480 g.
    const previous = initial?.value
    if (previous) {
      const match = previous.serving_label
        ? options.value.find((o) => o.label === previous.serving_label)
        : undefined
      if (match && previous.serving_count) {
        selectedKey.value = match.key
        amount.value = previous.serving_count
        return
      }

      // Swapping to a food whose own serving size doesn't match the old
      // label (a different product, or one that had none) — re-express the
      // carried weight as however many of *its* servings that comes to,
      // rather than dropping into a raw gram figure that reads like the
      // amount was reset.
      const stated = options.value.find((o) => o.kind === 'serving')
      if (stated && previous.grams) {
        selectedKey.value = stated.key
        amount.value = Math.round((previous.grams / stated.size) * 1000) / 1000
        return
      }

      const base = options.value.find((o) => o.kind === 'base')
      if (base) {
        selectedKey.value = base.key
        amount.value = roundGrams(previous.grams)
        return
      }
    }

    // Nothing logged before, so it's the user's preference that decides —
    // "always start me on grams" is a real way to eat, and being handed
    // "1 serving" of somebody else's idea of a serving every time isn't.
    // Only where a weight is honest: a recipe nobody weighed has no grams to
    // offer (see `showsGrams`), and there the food's serving is all there is.
    const preferredPortion = portionDefault?.value
      ? portionDefaultUnitKey(portionDefault.value, isLiquid.value)
      : null
    const byWeight = preferredPortion
      ? options.value.find((o) => o.key === `u:${preferredPortion}`)
      : undefined
    if (byWeight) {
      selectedKey.value = byWeight.key
      amount.value = defaultAmount(byWeight)
      return
    }

    // Otherwise the food's stated serving, else the user's preferred unit.
    const stated = options.value.find((o) => o.kind === 'serving')
    if (stated) {
      selectedKey.value = stated.key
      amount.value = 1
      return
    }
    const preferred = `u:${defaultUnitKey(system.value, isLiquid.value)}`
    const option = options.value.find((o) => o.key === preferred) ?? options.value[0]
    if (!option) return
    selectedKey.value = option.key
    amount.value = defaultAmount(option)
  })

  const selected = computed(() => options.value.find((o) => o.key === selectedKey.value))
  const grams = computed(() => (selected.value ? amount.value * selected.value.size : 0))

  /** "oz (28 g)" — the equivalence belongs in the option, not just after it. */
  function optionLabel(option: PortionOption): string {
    if (!showsGrams.value) return option.label
    if (option.size === 1 || STATES_SIZE.test(option.label)) return option.label
    return `${option.label} (${roundGrams(option.size)} ${unit.value})`
  }

  /**
   * Shown whenever the chosen unit isn't already grams/millilitres. Suppressed
   * for a single serving whose label states its own size, where the line would
   * just be "1 × 5.3 ONZ (150 g) = 150 g" — and for anything whose weight we
   * are not entitled to quote.
   */
  const conversion = computed(() => {
    const option = selected.value
    if (!option || !showsGrams.value) return null
    if (option.kind === 'base' || !amount.value) return null
    if (amount.value === 1 && STATES_SIZE.test(option.label)) return null
    return `${amount.value} × ${option.label} = ${roundGrams(grams.value)} ${unit.value}`
  })

  /**
   * Switching between "1 serving", "100 g" and "4 oz" keeps however much is
   * already typed, re-expressed in the new unit, so the logged weight doesn't
   * silently change under the portion you happened to pick. "2 × 90 g serving"
   * switching to grams lands on 180; "1 × 100 g" switching to a 90 g serving
   * lands on 1.1 (99 g, within a gram). `previousGrams` is the weight that was
   * on screen before the switch — the caller captures it, because by the time
   * this runs the selection has already moved. Only with nothing to preserve
   * does it fall back to the sensible starting amount.
   */
  function onPortionChange(previousGrams?: number) {
    const option = selected.value
    if (!option) return
    if (previousGrams !== undefined) {
      amount.value = portionAmount(previousGrams, option.size)
    } else {
      amount.value = defaultAmount(option)
    }
  }

  /** Exactly what the diary and a recipe ingredient both store. */
  const selection = computed<PortionSelection>(() => {
    const option = selected.value
    const named = option && option.kind !== 'base'
    return {
      grams: grams.value,
      serving_label: named ? option!.label : null,
      serving_count: named ? amount.value : null,
    }
  })

  /**
   * Returned `reactive`, not as loose refs, for one specific reason: the page
   * that owns this needs `grams` to render its nutrition preview, and the
   * picker component needs the same state to render its controls. Whoever owns
   * it must set it up *before* the first render — if the child owned it, the
   * server would render a real preview (child setup runs mid-render) while the
   * client's first pass still saw zero, and hydration would mismatch. So the
   * page owns it and hands the whole object down.
   */
  return reactive({
    isLiquid,
    unit,
    showsGrams,
    options,
    selectedKey,
    amount,
    selected,
    grams,
    conversion,
    selection,
    optionLabel,
    onPortionChange,
  })
}

export type PortionPickerState = ReturnType<typeof usePortionOptions>

import { computed, ref } from 'vue'
import { evaluateMath, fieldText, type MathResult } from '#shared/mathExpr'

/**
 * A numeric field that accepts arithmetic.
 *
 * Split out of `MathNumberInput.vue` on purpose: Vitest runs with
 * `environment: 'node'` and there is no `@vue/test-utils` here, so anything
 * that must stay pinned by a test cannot live in the component. What is left in
 * the `.vue` file is markup and the two DOM-only behaviours (text selection on
 * focus, and the preview chip).
 */

/** What the field wants the parent to store. */
export interface MathEmission {
  value: number | null
  /** The raw text, when it was an expression; null when it was just a number. */
  formula: string | null
}

export function useMathInput(opts: { min?: number } = {}) {
  /** The text on screen. Source of truth while the user has the field. */
  const text = ref('')

  /**
   * Set by the component's focus/blur handlers. The composable never touches
   * the DOM; it is told.
   */
  const focused = ref(false)

  const result = computed<MathResult>(() => evaluateMath(text.value, { min: opts.min }))

  /**
   * The `= 140` under the field. Only for a real expression: echoing `140` back
   * at someone who typed `140` is noise.
   */
  const previewValue = computed(() => (result.value.kind === 'value' ? result.value.value : null))

  /**
   * `incomplete` is deliberately not invalid. `100+` is what a half-typed sum
   * looks like, and flashing an error at every second keystroke would make the
   * field feel broken.
   */
  const invalid = computed(() => result.value.kind === 'error')

  /**
   * What to tell the parent after a keystroke, or **null for "say nothing"**.
   *
   * Holding the last good value through `incomplete` and `error` is what stops
   * the nutrition figures beside the field flickering to zero while someone
   * types the second half of `100+40`.
   */
  function emission(): MathEmission | null {
    const current = result.value
    if (current.kind === 'incomplete' || current.kind === 'error') return null
    if (current.kind === 'empty') return { value: null, formula: null }
    return {
      value: current.value,
      formula: current.kind === 'value' ? text.value.trim() : null,
    }
  }

  /**
   * Show a value that came from outside — a first render, a portion switch, a
   * saved row being reopened.
   *
   * Never while the field is focused: the parent re-emitting what it was just
   * told would otherwise rewrite the text under the caret mid-word.
   */
  function adopt(value: number | null, formula: string | null) {
    if (focused.value) return
    text.value = fieldText(value, formula, { min: opts.min })
  }

  return { text, focused, result, previewValue, invalid, emission, adopt }
}

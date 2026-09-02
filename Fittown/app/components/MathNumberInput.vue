<script setup lang="ts">
import { ref, watch } from 'vue'
import { useMathInput } from '~/composables/useMathInput'

/**
 * A numeric field that accepts arithmetic — `100+40`, `=50*3`, `50x4`,
 * `(100+50)*3` — with a live preview of what it comes to.
 *
 * **It is a text input, and has to be.** A `type="number"` box cannot hold
 * `100+40`: the browser discards non-numeric input and reports `''`.
 * `inputmode="decimal"` is kept anyway, so the fast numeric keypad is still
 * what comes up for the overwhelmingly common case of typing a plain amount;
 * operators cost one tap on the keyboard's symbol key.
 *
 * The rules live in `useMathInput()`, which is unit-tested; this file is markup
 * plus the two things that need a real DOM.
 */

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    modelValue: number | null
    /** The expression that produced the value, for fields that store one. */
    formula?: string | null
    /** The field's floor. A result below it is refused, never clamped. */
    min?: number
    /**
     * 'below' — a line under the field, for screens with room.
     * 'chip'  — a floating chip above it, for the cramped inline edit rows,
     *           where a line would make the row grow and shift the list.
     */
    preview?: 'below' | 'chip' | 'none'
    /** Classes for the positioning wrapper — `w-full` where the input fills. */
    wrapperClass?: string
  }>(),
  { formula: null, min: 0, preview: 'below', wrapperClass: '' },
)

const emit = defineEmits<{
  'update:modelValue': [number | null]
  'update:formula': [string | null]
}>()

const field = useMathInput({ min: props.min })
const { text, focused, previewValue, invalid } = field

const input = ref<HTMLInputElement | null>(null)

// The parent's value reaches the text only when the field is idle — `adopt()`
// itself refuses while focused, so a parent echoing back what it was just told
// cannot rewrite the text under the caret.
watch(
  () => [props.modelValue, props.formula] as const,
  ([value, formula]) => field.adopt(value, formula),
  { immediate: true },
)

function onInput() {
  const next = field.emission()
  if (!next) return
  if (next.value !== props.modelValue) emit('update:modelValue', next.value)
  if (next.formula !== props.formula) emit('update:formula', next.formula)
}

/**
 * Focusing selects what's in the box, so the first keypress replaces the figure
 * instead of extending it. Someone reaching for a box holding 100 and typing 2
 * means 2, not 1002.
 *
 * This moved here from PortionPicker.vue, where it was correct in exactly one
 * place. Every amount field now behaves the same way, and there is one copy to
 * keep correct.
 */
const selectionPending = ref(false)

function onFocus(event: FocusEvent) {
  focused.value = true
  ;(event.target as HTMLInputElement).select()
  selectionPending.value = true
}

/** A press *inside* an already-focused box is the caret being placed by hand. */
function onPointerDown() {
  selectionPending.value = false
}

/**
 * Only the release that completes the focusing click: left alone, it drops the
 * caret where the pointer went down and throws the selection away again.
 */
function onMouseUp(event: MouseEvent) {
  if (!selectionPending.value) return
  event.preventDefault()
  selectionPending.value = false
}

/**
 * Leaving settles the text. A field abandoned mid-expression (`100+`) or in an
 * error state goes back to showing the value that is actually stored, rather
 * than sitting there red.
 */
function onBlur() {
  focused.value = false
  selectionPending.value = false
  field.adopt(props.modelValue, props.formula)
}

defineExpose({
  focus: () => input.value?.focus(),
  select: () => input.value?.select(),
  /**
   * Push a value in directly, bypassing `modelValue`/`formula` props.
   *
   * Those props only change once the parent's own render effect re-runs and
   * repatches this component's vnode — which Vue always schedules
   * asynchronously, no matter what flush timing a watcher in here uses. A
   * caller that just mutated the reactive value it also passes as `v-model`
   * (so the new figure already exists, synchronously, in that caller's own
   * scope) and needs the field showing it *before* the props catch up —
   * PortionPicker.vue's selectOption(), immediately before a synchronous
   * focus() a soft keyboard depends on — should call this instead of waiting.
   */
  adopt: field.adopt,
})
</script>

<template>
  <div class="relative" :class="wrapperClass">
    <input
      ref="input"
      v-bind="$attrs"
      v-model="text"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      :class="{ 'input-error': invalid }"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @mousedown="onPointerDown"
      @mouseup="onMouseUp"
    >

    <!-- Absolutely positioned and focus-gated: an inline edit row is a
         [amount][unit][buttons] strip with no vertical room to spare, and a
         preview that took layout space would shift the whole list. -->
    <span
      v-if="preview === 'chip' && focused && previewValue !== null"
      class="absolute -top-6 right-0 z-20 rounded bg-neutral text-neutral-content text-xs px-1.5 py-0.5 shadow tabular whitespace-nowrap"
    >= {{ previewValue }}</span>

    <p
      v-else-if="preview === 'below' && previewValue !== null"
      class="text-xs text-base-content/60 tabular mt-1"
    >= {{ previewValue }}</p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { roundGrams } from '#shared/portions'
import type { PortionOption, PortionPickerState } from '~/composables/usePortionOptions'

/**
 * "How much of this?" — used both when logging a food and when putting one into
 * a recipe, so the two can never resolve the same words to different grams.
 *
 * Presentational on purpose: the state comes from `usePortionOptions()` in the
 * page, because the page renders a nutrition preview from the same grams and
 * has to have them before it renders. See the note in that composable.
 */
const props = defineProps<{ picker: PortionPickerState }>()

/** The amount field that should gain focus when a portion option is picked. */
const amountField = ref<HTMLInputElement | null>(null)

/** The in-page portion dropdown is open. */
const open = ref(false)

/** Anchor for the dropdown + its trigger, so a tap outside closes it. */
const portionColumn = ref<HTMLDivElement | null>(null)

function onDocumentPointerDown(event: PointerEvent) {
  if (
    open.value
    && portionColumn.value
    && !portionColumn.value.contains(event.target as Node)
  ) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

/**
 * Focusing the amount selects what's in it, so the first keypress replaces the
 * figure instead of extending it. The box is never empty — it always holds the
 * portion's starting amount — and someone reaching for it means "not that, this
 * much": tapping a box holding 100 and typing 2 should log 2, not 1002.
 */
const selectionPending = ref(false)

function onAmountFocus(event: FocusEvent) {
  ;(event.target as HTMLInputElement).select()
  selectionPending.value = true
}

/** A press *inside* an already-focused box is the caret being placed by hand. */
function onAmountPointerDown() {
  selectionPending.value = false
}

/**
 * Only the release that completes the focusing click: left alone, it drops the
 * caret where the pointer went down and throws the selection away again.
 */
function onAmountMouseUp(event: MouseEvent) {
  if (!selectionPending.value) return
  event.preventDefault()
  selectionPending.value = false
}

/**
 * Picking a portion option.
 *
 * This is deliberately NOT a native <select>. Firefox on Android never raises
 * the soft keyboard for a programmatic focus that follows a native picker — the
 * real touch is consumed by the OS selection control, so no timing trick (sync,
 * microtask, or macrotask) gives the focus genuine user activation. Making the
 * options real page buttons means the tap below is an authentic click, so the
 * focus it triggers is honoured and the keypad comes up for the amount field.
 */
function selectOption(option: PortionOption) {
  // Capture the weight on screen before the selection moves. Switching
  // portion types should re-express that weight in the new unit, not reset
  // the amount — "2 × 90 g serving" to grams means 180 g, not a 1 g portion.
  const previousGrams = props.picker.grams
  props.picker.selectedKey = option.key
  props.picker.onPortionChange(previousGrams)
  open.value = false
  amountField.value?.focus()
  amountField.value?.select()
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex gap-2">
      <label class="form-control flex-1">
        <span class="label-text text-xs mb-1">Amount</span>
        <input
          ref="amountField"
          v-model.number="picker.amount"
          type="number"
          min="0"
          step="any"
          inputmode="decimal"
          class="input input-bordered w-full"
          @focus="onAmountFocus"
          @mousedown="onAmountPointerDown"
          @mouseup="onAmountMouseUp"
        >
      </label>

      <label class="form-control flex-1 relative">
        <span class="label-text text-xs mb-1">Portion</span>
        <div ref="portionColumn" class="relative">
          <button
            type="button"
            class="btn btn-outline w-full justify-between"
            :aria-expanded="open"
            @click="open = !open"
          >
            <span class="truncate">
              {{ picker.selected ? picker.optionLabel(picker.selected) : '' }}
            </span>
            <AppIcon name="chevronDown" class="w-4 h-4 shrink-0 opacity-60" />
          </button>

          <div
            v-if="open"
            class="absolute right-0 z-10 mt-1 w-60 max-h-64 overflow-auto rounded-lg bg-base-100 border border-base-300 shadow-lg py-1"
          >
            <button
              v-for="option in picker.options"
              :key="option.key"
              type="button"
              class="w-full text-left px-3 py-2 text-sm hover:bg-base-200"
              :class="{ 'bg-base-200': option.key === picker.selectedKey }"
              @click="selectOption(option)"
            >
              {{ picker.optionLabel(option) }}
            </button>
          </div>
        </div>
      </label>
    </div>

    <p v-if="picker.conversion" class="text-xs text-base-content/60 tabular -mt-1">
      {{ picker.conversion }}
    </p>

    <slot />

    <!-- Weight is only quoted when we actually know it: a recipe with no stated
         yield is measured in servings, not grams. -->
    <p v-if="picker.showsGrams" class="text-xs text-base-content/50 tabular">
      Logging {{ roundGrams(picker.grams) }} {{ picker.unit }}
    </p>
  </div>
</template>

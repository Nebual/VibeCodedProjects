<script setup lang="ts">
import { roundGrams } from '#shared/portions'
import type { PortionPickerState } from '~/composables/usePortionOptions'

/**
 * "How much of this?" — used both when logging a food and when putting one into
 * a recipe, so the two can never resolve the same words to different grams.
 *
 * Presentational on purpose: the state comes from `usePortionOptions()` in the
 * page, because the page renders a nutrition preview from the same grams and
 * has to have them before it renders. See the note in that composable.
 */
defineProps<{ picker: PortionPickerState }>()
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex gap-2">
      <label class="form-control flex-1">
        <span class="label-text text-xs mb-1">Amount</span>
        <input
          v-model.number="picker.amount"
          type="number"
          min="0"
          step="any"
          inputmode="decimal"
          class="input input-bordered w-full"
        >
      </label>

      <label class="form-control flex-1">
        <span class="label-text text-xs mb-1">Portion</span>
        <select
          v-model="picker.selectedKey"
          class="select select-bordered w-full"
          @change="picker.onPortionChange()"
        >
          <option v-for="option in picker.options" :key="option.key" :value="option.key">
            {{ picker.optionLabel(option) }}
          </option>
        </select>
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

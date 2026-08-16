<script setup lang="ts">
import { addDays, humanDate } from '~/utils/dates'

const props = defineProps<{ today: string | null }>()
const date = defineModel<string | null>({ required: true })

// Don't let people log meals into next month by accident.
const maxDate = computed(() => (props.today ? addDays(props.today, 1) : undefined))
const atMax = computed(() => !!maxDate.value && !!date.value && date.value >= maxDate.value)
const label = computed(() =>
  date.value ? humanDate(date.value, props.today ?? date.value) : '…',
)
</script>

<template>
  <div class="flex items-center gap-1">
    <button
      class="btn btn-ghost btn-sm btn-square"
      aria-label="Previous day"
      :disabled="!date"
      @click="date && (date = addDays(date, -1))"
    >
      <AppIcon name="chevronLeft" class="w-5 h-5" />
    </button>

    <div class="flex-1 text-center relative">
      <span class="font-semibold">{{ label }}</span>
      <!-- Native picker overlays the label so the whole area is tappable. -->
      <input
        v-model="date"
        type="date"
        :max="maxDate"
        class="absolute inset-0 opacity-0 w-full cursor-pointer"
        aria-label="Choose date"
      >
    </div>

    <button
      class="btn btn-ghost btn-sm btn-square"
      aria-label="Next day"
      :disabled="atMax || !date"
      @click="date && (date = addDays(date, 1))"
    >
      <AppIcon name="chevronRight" class="w-5 h-5" />
    </button>

    <button
      v-if="today && date !== today"
      class="btn btn-ghost btn-xs"
      @click="date = today"
    >
      Today
    </button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  totalMl: number
  goalMl: number
  unit: 'ml' | 'floz'
}>()

const emit = defineEmits<{ add: [amountMl: number] }>()

const ML_PER_FLOZ = 29.5735

/** Quick-add sizes, in the user's own unit. */
const presets = computed(() =>
  props.unit === 'floz'
    ? [
        { label: '8 oz', ml: 8 * ML_PER_FLOZ },
        { label: '12 oz', ml: 12 * ML_PER_FLOZ },
        { label: '16 oz', ml: 16 * ML_PER_FLOZ },
      ]
    : [
        { label: '250 ml', ml: 250 },
        { label: '500 ml', ml: 500 },
        { label: '750 ml', ml: 750 },
      ],
)

function display(ml: number) {
  return props.unit === 'floz'
    ? `${Math.round(ml / ML_PER_FLOZ)} oz`
    : `${Math.round(ml)} ml`
}

const percent = computed(() =>
  Math.min(100, Math.round((props.totalMl / Math.max(props.goalMl, 1)) * 100)),
)

/** Eight glasses is the familiar mental model, so render the goal that way. */
const glasses = computed(() => {
  const size = props.goalMl / 8
  const filled = Math.floor(props.totalMl / size)
  return Array.from({ length: 8 }, (_, i) => i < filled)
})
</script>

<template>
  <section class="card bg-base-100 shadow-sm">
    <div class="card-body p-4 gap-3">
      <header class="flex items-center justify-between">
        <h2 class="font-semibold flex items-center gap-2">
          <AppIcon name="droplet" class="w-4 h-4 text-info" />
          Water
        </h2>
        <span class="text-sm text-base-content/60 tabular">
          {{ display(totalMl) }} <span class="text-base-content/40">/ {{ display(goalMl) }}</span>
        </span>
      </header>

      <div class="flex gap-1" :aria-label="`${percent}% of water goal`">
        <div
          v-for="(filled, i) in glasses"
          :key="i"
          class="h-2 flex-1 rounded-full transition-colors"
          :class="filled ? 'bg-info' : 'bg-base-300'"
        />
      </div>

      <div class="flex gap-2 flex-wrap">
        <button
          v-for="p in presets"
          :key="p.label"
          class="btn btn-sm btn-outline btn-info flex-1"
          @click="emit('add', p.ml)"
        >
          +{{ p.label }}
        </button>
        <button
          class="btn btn-sm btn-ghost btn-square"
          :disabled="totalMl <= 0"
          aria-label="Undo last water"
          @click="emit('add', -presets[0]!.ml)"
        >
          <AppIcon name="minus" class="w-4 h-4" />
        </button>
      </div>
    </div>
  </section>
</template>

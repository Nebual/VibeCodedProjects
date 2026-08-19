<script setup lang="ts">
import { PauseIcon, PlayIcon } from '@heroicons/vue/24/solid'

const props = defineProps<{
  isPlaying: boolean
  currentTime: number
  duration: number
  /** Fraction (0..1) along the track to render a fixed marker tick, e.g. a cut point. */
  markerFraction?: number
}>()

const emit = defineEmits<{
  toggle: []
  seek: [time: number]
}>()

function onSeek(e: Event) {
  emit('seek', Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="flex items-center gap-2">
    <button class="btn btn-xs btn-circle" :aria-label="isPlaying ? 'Pause' : 'Play'" @click="emit('toggle')">
      <PauseIcon v-if="isPlaying" class="w-3 h-3" />
      <PlayIcon v-else class="w-3 h-3" />
    </button>
    <div class="relative flex-1 min-w-24">
      <input
        type="range"
        class="range range-xs w-full"
        min="0"
        :max="props.duration || 0"
        step="0.05"
        :value="props.currentTime"
        @input="onSeek"
      >
      <div
        v-if="markerFraction != null"
        class="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-warning pointer-events-none"
        :style="{ left: `${markerFraction * 100}%` }"
      />
    </div>
    <span class="text-xs text-base-content/60 tabular-nums">
      {{ formatDuration(props.currentTime) }} / {{ formatDuration(props.duration || 0) }}
    </span>
  </div>
</template>

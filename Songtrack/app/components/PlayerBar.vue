<script setup lang="ts">
import { ArrowPathRoundedSquareIcon, PauseIcon, PlayIcon } from '@heroicons/vue/24/solid'
import { ArrowUturnLeftIcon, ArrowUturnRightIcon, SpeakerWaveIcon } from '@heroicons/vue/24/outline'

const player = usePlayer()
const { currentSong, isPlaying, currentTime, duration, playbackRate, loop } = player
const monitorGain = useMonitorGain()

function onSeek(e: Event) {
  player.seek(Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <div
    v-if="currentSong"
    class="fixed bottom-0 inset-x-0 bg-base-100 border-t border-base-300 px-4 py-2 flex items-center gap-3 z-20"
  >
    <button class="btn btn-circle btn-sm" title="Back 10 seconds" @click="player.skip(-10)">
      <ArrowUturnLeftIcon class="w-4 h-4" />
    </button>
    <button
      class="btn btn-circle btn-primary btn-sm"
      :title="isPlaying ? 'Pause' : 'Play'"
      @click="isPlaying ? player.pause() : player.play(currentSong)"
    >
      <PauseIcon v-if="isPlaying" class="w-4 h-4" />
      <PlayIcon v-else class="w-4 h-4" />
    </button>
    <button class="btn btn-circle btn-sm" title="Forward 10 seconds" @click="player.skip(10)">
      <ArrowUturnRightIcon class="w-4 h-4" />
    </button>

    <div class="flex-1 min-w-0 -mt-2">
      <div class="truncate text-sm font-medium -mb-1">{{ currentSong.title }}</div>
      <input
        type="range"
        class="range range-xs w-full"
        min="0"
        :max="duration || 0"
        step="0.1"
        :value="currentTime"
        @input="onSeek"
      >
    </div>

    <div class="items-center gap-1 hidden sm:flex">
      <SpeakerWaveIcon class="w-4 h-4 text-base-content/60" />
      <input
        v-model.number="monitorGain.targetLevelDb.value"
        type="range"
        class="w-20 accent-primary"
        :min="monitorGain.minTargetDb"
        :max="monitorGain.maxTargetDb"
        step="1"
        aria-label="Volume"
      >
    </div>

    <span class="text-xs text-base-content/60 tabular-nums hidden sm:inline">
      {{ formatDuration(currentTime) }} / {{ formatDuration(duration || 0) }}
    </span>

    <select
      class="select select-xs select-bordered hidden sm:block max-w-16"
      :value="playbackRate"
      @change="player.setPlaybackRate(Number(($event.target as HTMLSelectElement).value))"
    >
      <option :value="0.75">0.75×</option>
      <option :value="1">1×</option>
      <option :value="1.25">1.25×</option>
      <option :value="1.5">1.5×</option>
    </select>

    <button
      class="btn btn-xs btn-circle"
      :class="loop ? 'btn-primary' : 'btn-ghost'"
      aria-label="Loop"
      title="Loop"
      @click="player.setLoop(!loop)"
    >
      <ArrowPathRoundedSquareIcon class="w-4 h-4" />
    </button>
  </div>
</template>

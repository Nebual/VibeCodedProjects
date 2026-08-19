<script setup lang="ts">
const player = usePlayer()
const { currentSong, isPlaying, currentTime, duration, playbackRate, loop } = player

function onSeek(e: Event) {
  player.seek(Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <div
    v-if="currentSong"
    class="fixed bottom-0 inset-x-0 bg-base-100 border-t border-base-300 px-4 py-2 flex items-center gap-3 z-20"
  >
    <button class="btn btn-circle btn-sm" @click="player.skip(-10)">−10</button>
    <button class="btn btn-circle btn-primary btn-sm" @click="isPlaying ? player.pause() : player.play(currentSong)">
      {{ isPlaying ? '⏸' : '▶' }}
    </button>
    <button class="btn btn-circle btn-sm" @click="player.skip(10)">+10</button>

    <div class="flex-1 min-w-0">
      <div class="truncate text-sm font-medium">{{ currentSong.title }}</div>
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

    <span class="text-xs text-base-content/60 tabular-nums hidden sm:inline">
      {{ formatDuration(currentTime) }} / {{ formatDuration(duration || 0) }}
    </span>

    <select
      class="select select-xs select-bordered hidden sm:block"
      :value="playbackRate"
      @change="player.setPlaybackRate(Number(($event.target as HTMLSelectElement).value))"
    >
      <option :value="0.75">0.75×</option>
      <option :value="1">1×</option>
      <option :value="1.25">1.25×</option>
      <option :value="1.5">1.5×</option>
    </select>

    <button
      class="btn btn-xs"
      :class="loop ? 'btn-primary' : 'btn-ghost'"
      title="Loop"
      @click="player.setLoop(!loop)"
    >
      🔁
    </button>
  </div>
</template>

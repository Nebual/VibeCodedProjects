<script setup lang="ts">
import type { Health } from '~/types/api'

const { data: health, error } = await useFetch<Health>('/api/health')

/** Configured for remote synthesis but serving from somewhere else. */
const fellBack = computed(() => {
  const tts = health.value?.tts
  return !!tts && tts.configured === 'remote' && tts.active !== 'remote'
})

const missing = computed(() => {
  if (!health.value) return []
  return Object.entries(health.value.deps)
    .filter(([, present]) => !present)
    .map(([name]) => name.replace('_', '-'))
})
</script>

<template>
  <div class="flex items-center gap-2 text-xs">
    <template v-if="error">
      <span class="badge badge-error badge-sm">API offline</span>
    </template>
    <template v-else-if="health">
      <div
        v-if="missing.length"
        class="tooltip tooltip-bottom"
        :data-tip="`Missing on PATH: ${missing.join(', ')}`"
      >
        <span class="badge badge-warning badge-sm">degraded</span>
      </div>
      <span v-else class="badge badge-success badge-sm">ready</span>

      <!-- The backend actually serving, not the one configured. They diverge
           silently when a remote node is unreachable and work falls back to
           local CPU. -->
      <div
        v-if="health.tts"
        class="tooltip tooltip-bottom"
        :data-tip="health.tts.detail"
      >
        <span
          class="badge badge-sm"
          :class="health.tts.available ? 'badge-ghost' : 'badge-error'"
        >{{ health.tts.active ?? health.tts.configured }}</span>
      </div>

      <span
        v-if="fellBack"
        class="badge badge-warning badge-sm"
        title="Configured for remote synthesis but currently running locally"
      >local fallback</span>

      <span class="text-base-content/40 hidden sm:inline">
        v{{ health.version }}
      </span>
    </template>
  </div>
</template>

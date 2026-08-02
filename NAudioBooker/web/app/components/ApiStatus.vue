<script setup lang="ts">
import type { Health } from '~/types/api'

const { data: health, error } = await useFetch<Health>('/api/health')

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
      <span class="text-base-content/40 hidden sm:inline">
        {{ health.tts_backend }} · v{{ health.version }}
      </span>
    </template>
  </div>
</template>

<script setup lang="ts">
useHead({ title: 'Trends · Fittown' })

/**
 * Your own trends. The charts themselves live in `TrendsPanel` so that a
 * friend's page draws the identical thing from their summary endpoint.
 */
</script>

<template>
  <TrendsPanel source="/api/summary">
    <template #title>
      <h1 class="font-semibold text-lg">Trends</h1>
    </template>
  </TrendsPanel>
</template>

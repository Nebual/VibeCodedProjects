<template>
  <NuxtLayout>
    <NuxtPage :key="pageKey" />
  </NuxtLayout>
</template>

<script setup lang="ts">
const route = useRoute()
const { identity } = useIdentity()
// re-mount pages when the chosen player changes so their data loads fresh
const pageKey = computed(() => `${route.fullPath}|${identity.value?.playerId ?? 'anon'}`)
</script>

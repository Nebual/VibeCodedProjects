<script setup lang="ts">
const route = useRoute()
const { identity } = useIdentity()
// re-mount pages when the chosen player changes so their data loads fresh
const pageKey = computed(() => `${route.fullPath}|${identity.value?.playerId ?? 'anon'}`)

useHead({
  link: [{ rel: 'icon', type: 'image/png', href: '/icon.png' }],
  title: 'Bloodtrack',
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage :key="pageKey" />
  </NuxtLayout>
</template>

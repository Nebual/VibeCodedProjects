<script setup lang="ts">
import { generateListName } from '#shared/listName'

/**
 * There is no landing page to speak of — send people straight back to whatever list
 * they were last using, or mint them a fresh one.
 */
onMounted(() => {
  const last = localStorage.getItem('nshoppinglist:last')
  navigateTo(`/l/${last || generateListName()}`, { replace: true })
})
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center">
    <span class="loading loading-dots loading-lg opacity-40" />
  </div>
</template>

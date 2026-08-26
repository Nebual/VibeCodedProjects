<script setup lang="ts">
const { identity, logout } = useIdentity()
</script>

<template>
  <div class="navbar bg-base-200 shadow mb-4">
    <div class="flex-1">
      <NuxtLink to="/" class="btn btn-ghost text-xl">🩸 Bloodtrack</NuxtLink>
    </div>
    <div v-if="identity" class="flex-none flex items-center gap-2">
      <span class="text-sm opacity-70">Playing as <b>{{ identity.playerName }}</b></span>
      <NuxtLink :to="`/player/${identity.leagueId}`" class="btn btn-sm btn-ghost">My Matches</NuxtLink>
      <NuxtLink :to="`/standings/${identity.leagueId}`" class="btn btn-sm btn-ghost">Standings</NuxtLink>
      <button class="btn btn-sm btn-outline" @click="logout()">Logout</button>
    </div>
  </div>
  <main class="container mx-auto px-4 pb-10">
    <slot />
  </main>
</template>

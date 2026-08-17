<script setup lang="ts">
/**
 * Layout for the pages a stranger can land on: a shared recipe link and an
 * invite link.
 *
 * The default layout's dock and header are navigation around a diary that a
 * signed-out visitor doesn't have, and showing them would offer four tabs that
 * all bounce off the auth middleware. This is the same shell with nothing but a
 * way in.
 */
const { loggedIn } = useUserSession()
const route = useRoute()
</script>

<template>
  <div class="min-h-dvh bg-base-200">
    <header class="navbar bg-base-100 border-b border-base-300 sticky top-0 z-30">
      <div class="mx-auto w-full max-w-3xl px-2 flex items-center gap-2">
        <NuxtLink to="/" class="btn btn-ghost text-lg font-semibold gap-2">
          <AppLogo class="w-6 h-6" />
          Fittown
        </NuxtLink>
        <div class="flex-1" />
        <NuxtLink v-if="loggedIn" to="/" class="btn btn-ghost btn-sm">My diary</NuxtLink>
        <NuxtLink
          v-else
          :to="{ path: '/login', query: { redirect: route.fullPath } }"
          class="btn btn-primary btn-sm"
        >
          Sign in
        </NuxtLink>
      </div>
    </header>

    <main class="mx-auto w-full max-w-3xl px-3 py-3 sm:py-6">
      <slot />
    </main>
  </div>
</template>

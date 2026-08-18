<script setup lang="ts">
const { user, clear } = useUserSession()
const route = useRoute()

async function signOut() {
  await $fetch('/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}

/**
 * The phone dock.
 */
const navItems = [
  { to: '/', label: 'Diary', icon: 'book' },
  { to: '/recipes', label: 'Recipes', icon: 'scale' },
  { to: '/fitness', label: 'Fitness', icon: 'activity' },
  { to: '/trends', label: 'Trends', icon: 'chart' },
  { to: '/friends', label: 'Friends', icon: 'friends' },
  { to: '/settings', label: 'Settings', icon: 'cog' },
]

/** The desktop header */
const headerItems = [
  ...navItems,
]

// The dock highlights the section, so '/food/123' still lights up Diary.
function isActive(to: string) {
  return to === '/' ? route.path === '/' : route.path.startsWith(to)
}
</script>

<template>
  <div class="min-h-dvh bg-base-200">
    <!-- Desktop / tablet header. Hidden on phones, where the dock navigates. -->
    <header class="navbar bg-base-100 border-b border-base-300 hidden sm:flex sticky top-0 z-30">
      <div class="mx-auto w-full max-w-5xl px-2 flex items-center gap-2">
        <NuxtLink to="/" class="btn btn-ghost text-xl font-semibold gap-2">
          <AppLogo class="w-6 h-6" />
          Fittown
        </NuxtLink>

        <nav class="flex-1 flex gap-1">
          <NuxtLink
            v-for="item in headerItems"
            :key="item.to"
            :to="item.to"
            class="btn btn-ghost btn-sm"
            :class="{ 'btn-active': isActive(item.to) }"
          >
            {{ item.label }}
          </NuxtLink>
        </nav>

        <div v-if="user" class="dropdown dropdown-end">
          <div tabindex="0" role="button" class="btn btn-ghost btn-circle avatar">
            <div class="w-9 rounded-full bg-neutral text-neutral-content grid place-items-center">
              <img v-if="user.avatar" :src="user.avatar as string" :alt="user.name as string">
              <span v-else class="text-sm">{{ (user.name as string)?.[0]?.toUpperCase() ?? '?' }}</span>
            </div>
          </div>
          <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box z-40 w-52 p-2 shadow-lg">
            <li class="menu-title truncate">{{ user.email }}</li>
            <li><NuxtLink to="/settings">Settings</NuxtLink></li>
            <li><button @click="signOut">Sign out</button></li>
          </ul>
        </div>
      </div>
    </header>

    <main class="mx-auto w-full max-w-3xl px-3 py-3 sm:py-6 pb-dock sm:pb-6">
      <slot />
    </main>

    <!-- Phone navigation. `dock` is DaisyUI 5's bottom bar. -->
    <nav class="dock sm:hidden bg-base-100 border-t border-base-300 z-30">
      <NuxtLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        :class="{ 'dock-active': isActive(item.to) }"
      >
        <AppIcon :name="item.icon" class="w-5 h-5" />
        <span class="dock-label">{{ item.label }}</span>
      </NuxtLink>
    </nav>

    <!--
      Asks about incoming friend requests wherever the user happens to be.
      In the layout rather than on the Friends tab because the whole point is
      that someone who was added by email hasn't gone looking for it.
    -->
    <FriendRequestPrompt v-if="user" />
  </div>
</template>

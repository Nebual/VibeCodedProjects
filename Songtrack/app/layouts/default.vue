<script setup lang="ts">
import { ArrowUpTrayIcon } from '@heroicons/vue/24/outline'

const route = useRoute()
const { user, clear } = useUserSession()
const { data: me, refresh: refreshMe } = useMe()
usePlayerShortcuts()

async function signOut() {
  await clear()
  await navigateTo('/login')
}

const exitingImpersonation = ref(false)
async function exitImpersonation() {
  exitingImpersonation.value = true
  try {
    await $fetch('/api/admin/impersonate/stop', { method: 'POST' })
    await refreshMe()
    await refreshNuxtData()
  } finally {
    exitingImpersonation.value = false
  }
}

// Upload modal (multi-file upload, one song per file, queued client-side).
// Queue state lives in the composable inside <UploadModal>, which stays mounted
// app-wide via this layout — so closing the modal mid-upload keeps uploads running.
const showUploadModal = ref(false)
</script>

<template>
  <div class="min-h-screen flex flex-col bg-base-200">
    <div
      v-if="me?.isImpersonating"
      class="bg-warning text-warning-content px-4 py-2 flex items-center justify-between gap-4 text-sm"
    >
      <span>
        Viewing as <strong>{{ me.user.name }}</strong> ({{ me.user.email }}) — changes you make are
        attributed to you in the audit log.
      </span>
      <button class="btn btn-xs" :disabled="exitingImpersonation" @click="exitImpersonation">
        Exit
      </button>
    </div>

    <header class="navbar bg-base-100 shadow-sm px-4">
      <div class="flex-1">
        <NuxtLink to="/" class="text-lg font-semibold">Songtrack</NuxtLink>
      </div>
      <div class="flex items-center gap-2">
        <NuxtLink to="/albums" class="btn btn-ghost btn-sm">Albums</NuxtLink>
        <button class="btn btn-ghost btn-sm gap-1" aria-label="Upload songs" @click="showUploadModal = true">
          <ArrowUpTrayIcon class="w-4 h-4" />
          <span class="hidden sm:inline">Upload</span>
        </button>
        <NuxtLink to="/record" class="btn btn-primary btn-sm">Record</NuxtLink>
        <NuxtLink v-if="user?.role === 'admin'" to="/admin" class="btn btn-ghost btn-sm">
          Admin
        </NuxtLink>
        <div class="dropdown dropdown-end">
          <div tabindex="0" role="button" class="btn btn-ghost btn-circle avatar">
            <div class="w-8 rounded-full">
              <img v-if="user?.avatarUrl" :src="user.avatarUrl" :alt="user.name">
              <div v-else class="bg-neutral text-neutral-content w-8 rounded-full flex items-center justify-center">
                {{ user?.name?.[0] ?? '?' }}
              </div>
            </div>
          </div>
          <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box shadow w-48 mt-2 z-10">
            <li class="menu-title">{{ user?.name }}</li>
            <li><button @click="signOut">Sign out</button></li>
          </ul>
        </div>
      </div>
    </header>

    <main class="flex-1 pb-16">
      <slot />
    </main>

    <PlayerBar v-if="!route.meta.hidePlayerBar" />

    <UploadModal :open="showUploadModal" @close="showUploadModal = false" />
  </div>
</template>

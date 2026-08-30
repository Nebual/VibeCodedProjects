<script setup lang="ts">
/**
 * Sideloaded APKs don't auto-update (docs/samsung-health-sync.md §6) — this
 * is the only thing that tells someone there's a newer build to go get.
 * Compares the installed app's own version (`@capacitor/app`'s `App.getInfo()`,
 * which reads it from the native package info — the same value
 * `mobile/android/app/build.gradle` set from `mobile/version.json` at build
 * time) against what the currently deployed server reports via
 * `GET /api/app-version`, reading the same file live.
 *
 * Self-contained like InstallPrompt.vue — no reason for a separate plugin
 * when nothing else on the page needs this state.
 */
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

const { public: publicConfig } = useRuntimeConfig()

const DISMISS_KEY_PREFIX = 'fittown.appVersionNagDismissed.'

const availableVersion = ref<string | null>(null)
const dismissed = ref(true) // hidden until onMounted proves otherwise, so SSR/hydration render nothing

const visible = computed(() => !dismissed.value && availableVersion.value !== null)

function dismiss() {
  dismissed.value = true
  if (!availableVersion.value) return
  try {
    localStorage.setItem(`${DISMISS_KEY_PREFIX}${availableVersion.value}`, '1')
  } catch {
    // Private browsing may refuse localStorage; it'll just ask again next launch.
  }
}

onMounted(async () => {
  if (!Capacitor.isNativePlatform()) return

  try {
    const [info, server] = await Promise.all([
      App.getInfo(),
      $fetch<{ version: string | null }>('/api/app-version'),
    ])
    if (!server.version || server.version === info.version) return

    const alreadyDismissed = (() => {
      try {
        return localStorage.getItem(`${DISMISS_KEY_PREFIX}${server.version}`) === '1'
      } catch {
        return false
      }
    })()
    if (alreadyDismissed) return

    availableVersion.value = server.version
    dismissed.value = false
  } catch {
    // No network, or this deployment has no mobile/version.json — not worth
    // surfacing as an error for a nag nobody's blocked on.
  }
})
</script>

<template>
  <div
    v-if="visible"
    class="toast toast-center sm:toast-end z-40 bottom-[calc(var(--dock-height)+env(safe-area-inset-bottom,0px)+0.75rem)] sm:bottom-4"
  >
    <div class="alert bg-base-100 shadow-lg items-start max-w-sm sm:max-w-xs">
      <AppIcon name="watch" class="w-5 h-5 shrink-0 mt-0.5" />

      <div class="text-sm min-w-0">
        <p class="font-medium">A newer Fittown build is available</p>
        <p class="text-base-content/70">
          Version {{ availableVersion }} is out — this app doesn't auto-update.
          <a
            v-if="publicConfig.appDownloadUrl"
            :href="publicConfig.appDownloadUrl"
            class="link"
          >Download it</a>
          <span v-else>Ask whoever built it for the updated APK.</span>
        </p>
      </div>

      <button class="btn btn-ghost btn-xs shrink-0" @click="dismiss">
        <AppIcon name="x" class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>

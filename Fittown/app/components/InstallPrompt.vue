<script setup lang="ts">
/**
 * Encourages adding Fittown to the home screen so it opens full-screen like
 * an app instead of as a browser tab.
 *
 * There's no cross-browser API for this. Chromium (Chrome/Edge/Samsung
 * Internet) fires `beforeinstallprompt`, which we capture and trigger for
 * real. Firefox — desktop and Android — and iOS Safari never fire it and
 * expose no JS hook at all, so for them this can only show instructions for
 * the manual steps. Firefox desktop has no home-screen concept to add to, so
 * it gets no banner.
 */
type Variant = 'chromium' | 'ios' | 'firefox-android' | null

const DISMISS_KEY = 'fittown.installPromptDismissedAt'
// Long enough not to nag every visit, short enough that a phone bought or
// reset in the meantime still gets asked.
const DISMISS_DAYS = 60

const FIRST_SEEN_KEY = 'fittown.installPromptFirstSeenAt'
// Let someone poke around before asking them to commit to installing it.
const DELAY_MS = 30 * 60 * 1000

const deferredPrompt = ref<Event | null>(null)
// A `beforeinstallprompt` event can only be prompted once, but the banner
// should keep offering "Install" (once a fresh event arrives) rather than
// vanish the moment the first one is spent — see chromiumEligible below.
const chromiumEligible = ref(false)
const standalone = ref(false)
const dismissed = ref(true) // hidden until onMounted proves otherwise, so SSR/hydration render nothing
const ready = ref(false) // flips true once the delay has elapsed, possibly mid-visit via the timer below
const installing = ref(false)

function wasDismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    return Date.now() - Number(raw) < DISMISS_DAYS * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

function dismiss() {
  dismissed.value = true
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    // Private browsing may refuse localStorage; the banner just won't remember.
  }
}

function onBeforeInstallPrompt(event: Event) {
  event.preventDefault()
  deferredPrompt.value = event
  chromiumEligible.value = true
}

const variant = computed<Variant>(() => {
  if (chromiumEligible.value) return 'chromium'
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios'
  if (/Firefox/.test(ua) && /Android/.test(ua)) return 'firefox-android'
  return null
})

const visible = computed(() => ready.value && !standalone.value && !dismissed.value && variant.value !== null)

async function install() {
  const event = deferredPrompt.value as (Event & { prompt: () => void, userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }) | null
  if (!event) return
  installing.value = true
  event.prompt()
  const choice = await event.userChoice
  installing.value = false
  // Spent either way — the same event can't be prompted twice.
  deferredPrompt.value = null
  // Only a real install (or our own X) should stop the banner for good. A
  // mis-click on the browser's own cancel shouldn't read as "never ask again";
  // the banner just loses its Install button until a fresh event arrives.
  if (choice.outcome === 'accepted') dismiss()
}

let readyTimer: ReturnType<typeof setTimeout> | undefined

function scheduleReady() {
  let firstSeenAt: number
  try {
    const raw = localStorage.getItem(FIRST_SEEN_KEY)
    if (raw) {
      firstSeenAt = Number(raw)
    } else {
      firstSeenAt = Date.now()
      localStorage.setItem(FIRST_SEEN_KEY, String(firstSeenAt))
    }
  } catch {
    // Private browsing may refuse localStorage; without a way to remember the
    // first visit, treat this one as it — the delay still applies, just fresh
    // every time rather than counting from whenever they first showed up.
    firstSeenAt = Date.now()
  }

  const remaining = DELAY_MS - (Date.now() - firstSeenAt)
  if (remaining <= 0) {
    ready.value = true
  } else {
    // Covers a visit that started under the delay and is still open when it
    // elapses, not just one that reloads after.
    readyTimer = setTimeout(() => { ready.value = true }, remaining)
  }
}

onMounted(() => {
  standalone.value
    = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true
  dismissed.value = wasDismissedRecently()
  scheduleReady()
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  clearTimeout(readyTimer)
})
</script>

<template>
  <div
    v-if="visible"
    class="toast toast-center sm:toast-end z-40 bottom-[calc(var(--dock-height)+env(safe-area-inset-bottom,0px)+0.75rem)] sm:bottom-4"
  >
    <div class="alert bg-base-100 shadow-lg items-start max-w-sm sm:max-w-xs">
      <AppIcon name="download" class="w-5 h-5 shrink-0 mt-0.5" />

      <div class="text-sm min-w-0">
        <template v-if="variant === 'chromium'">
          <p class="font-medium">Install Fittown</p>
          <p class="text-base-content/70">Add it to your home screen for quick, full-screen access.</p>
        </template>
        <template v-else-if="variant === 'ios'">
          <p class="font-medium">Add Fittown to your home screen</p>
          <p class="text-base-content/70">
            Tap <AppIcon name="share" class="w-4 h-4 inline-block align-text-bottom" />
            Share, then "Add to Home Screen".
          </p>
        </template>
        <template v-else-if="variant === 'firefox-android'">
          <p class="font-medium">Add Fittown to your home screen</p>
          <p class="text-base-content/70">Open the ⋮ menu, More, and tap "Add to home screen".</p>
        </template>
      </div>

      <div class="flex gap-1 shrink-0">
        <button
          v-if="variant === 'chromium' && deferredPrompt"
          class="btn btn-primary btn-xs"
          :disabled="installing"
          @click="install"
        >
          Install
        </button>
        <button class="btn btn-ghost btn-xs btn-square" aria-label="Dismiss" @click="dismiss">
          <AppIcon name="x" class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>
</template>

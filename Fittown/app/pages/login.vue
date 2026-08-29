<script setup lang="ts">
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'

definePageMeta({ layout: false })

const route = useRoute()
const { fetch: refreshSession, loggedIn } = useUserSession()

const devLoginAvailable = import.meta.dev
const isNative = Capacitor.isNativePlatform()
const busy = ref(false)
const error = ref<string | null>(
  route.query.error === 'oauth' ? 'Google sign-in failed. Please try again.' : null,
)

// Already signed in? Don't make them look at a login screen.
watchEffect(() => {
  if (loggedIn.value) navigateTo((route.query.redirect as string) || '/')
})

/**
 * A plain `<a href="/auth/google">` works in a real browser but not inside
 * the Capacitor WebView: Google refuses to run inside a WebView's user
 * agent, and — the failure actually seen here — starting the flow in the
 * WebView and letting Capacitor pop the redirect to Google out into Chrome
 * mid-flight splits the OAuth state cookie across two different cookie
 * jars, which reads as "state mismatch" on the way back.
 *
 * Browser.open() launches the *entire* flow in one Chrome Custom Tab from
 * the first request, so both legs share one cookie jar. The server
 * recognises `?client=app` (server/routes/auth/google.get.ts) and redirects
 * the Custom Tab to fittown://pair?code=… on success instead of opening a
 * session there — the app's own deep-link listener
 * (app/plugins/device-auth.client.ts) picks it up from there. See
 * docs/samsung-health-sync.md §3.
 */
async function signInWithGoogleNative() {
  await Browser.open({ url: `${window.location.origin}/auth/google?client=app` })
}

async function devLogin() {
  busy.value = true
  error.value = null
  try {
    await $fetch('/auth/dev', { method: 'POST', body: { email: 'dev@fittown.local', name: 'Dev User' } })
    await refreshSession()
    await navigateTo((route.query.redirect as string) || '/')
  } catch {
    error.value = 'Dev sign-in is not enabled on this server.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-h-dvh bg-base-200 grid place-items-center p-4">
    <div class="card w-full max-w-sm bg-base-100 shadow-xl">
      <div class="card-body items-center text-center gap-4">
        <AppLogo class="w-14 h-14" />
        <div>
          <h1 class="text-2xl font-semibold">Fittown</h1>
          <p class="text-sm text-base-content/60 mt-1">
            Track food, recipes, water, and exercise.
          </p>
        </div>

        <div v-if="error" class="alert alert-error text-sm py-2">
          {{ error }}
        </div>

        <a v-if="!isNative" href="/auth/google" class="btn btn-primary w-full gap-2">
          <svg class="w-5 h-5" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615Z" />
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18Z" />
            <path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.348 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332Z" />
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" />
          </svg>
          Continue with Google
        </a>

        <button v-else class="btn btn-primary w-full gap-2" @click="signInWithGoogleNative">
          <svg class="w-5 h-5" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615Z" />
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18Z" />
            <path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.348 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332Z" />
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" />
          </svg>
          Continue with Google
        </button>

        <NuxtLink v-if="isNative" to="/pair" class="link link-hover text-xs text-base-content/60">
          Have a pairing code instead?
        </NuxtLink>

        <template v-if="devLoginAvailable">
          <div class="divider text-xs my-0">development</div>
          <button class="btn btn-outline btn-sm w-full" :disabled="busy" @click="devLogin">
            <span v-if="busy" class="loading loading-spinner loading-xs" />
            Sign in as Dev User
          </button>
          <p class="text-xs text-base-content/50">
            Only works when the server sets <code>FITTOWN_DEV_LOGIN=1</code>.
          </p>
        </template>
      </div>
    </div>
  </div>
</template>

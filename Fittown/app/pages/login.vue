<script setup lang="ts">
definePageMeta({ layout: false })

const route = useRoute()
const { fetch: refreshSession, loggedIn } = useUserSession()

const devLoginAvailable = import.meta.dev
const busy = ref(false)
const error = ref<string | null>(
  route.query.error === 'oauth' ? 'Google sign-in failed. Please try again.' : null,
)

// Already signed in? Don't make them look at a login screen.
watchEffect(() => {
  if (loggedIn.value) navigateTo((route.query.redirect as string) || '/')
})

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
            Track food, water and training.
          </p>
        </div>

        <div v-if="error" class="alert alert-error text-sm py-2">
          {{ error }}
        </div>

        <a href="/auth/google" class="btn btn-primary w-full gap-2">
          <svg class="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8a12 12 0 1 1 7.9-21l5.7-5.7A20 20 0 1 0 24 44a20 20 0 0 0 19.6-23.9Z" />
            <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8A12 12 0 0 1 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7A20 20 0 0 0 6.3 14.7Z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 12.7 28l-6.5 5A20 20 0 0 0 24 44Z" />
            <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 40.2 44 35 44 24a20 20 0 0 0-.4-3.9Z" />
          </svg>
          Continue with Google
        </a>

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

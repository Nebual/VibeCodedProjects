<script setup lang="ts">
/**
 * Claim a pairing code and open a session (docs/samsung-health-sync.md §3).
 *
 * Reached two ways: typed in by hand (Settings' "Connect a phone" shows the
 * code on a signed-in browser, elsewhere), or pre-filled via `?code=` —
 * either the fittown://pair deep link's own listener
 * (app/plugins/device-auth.client.ts) routing here, or the app's own Google
 * sign-in button landing here directly after OAuth completes in the browser
 * it opened.
 */
definePageMeta({ layout: false })

const route = useRoute()
const { loggedIn } = useUserSession()

const code = ref((route.query.code as string | undefined)?.toUpperCase() ?? '')
const busy = ref(false)
const error = ref<string | null>(null)
const autoSubmitted = ref(false)

// Already signed in — a stale or re-opened link. Nothing to do here.
watchEffect(() => {
  if (loggedIn.value) navigateTo('/')
})

async function connect() {
  if (code.value.length !== 8 || busy.value) return
  busy.value = true
  error.value = null
  try {
    await claimPairingCode(code.value)
    await navigateTo('/')
  } catch {
    error.value = 'That code is wrong, already used, or has expired. Generate a new one from Settings on the device you signed in on.'
  } finally {
    busy.value = false
  }
}

// A code that arrived pre-filled is worth trying immediately rather than
// making the user press Connect on a value they didn't type.
onMounted(() => {
  if (code.value.length === 8 && !autoSubmitted.value) {
    autoSubmitted.value = true
    connect()
  }
})
</script>

<template>
  <div class="min-h-dvh bg-base-200 grid place-items-center p-4">
    <div class="card w-full max-w-sm bg-base-100 shadow-xl">
      <div class="card-body items-center text-center gap-4">
        <AppLogo class="w-14 h-14" />
        <div>
          <h1 class="text-2xl font-semibold">Connect this phone</h1>
          <p class="text-sm text-base-content/60 mt-1">
            Enter the code shown under
            <span class="whitespace-nowrap">Settings → Connect a phone</span>
            on a browser you're already signed in on.
          </p>
        </div>

        <div v-if="error" class="alert alert-error text-sm py-2">
          {{ error }}
        </div>

        <form class="w-full flex flex-col gap-3" @submit.prevent="connect">
          <input
            v-model="code"
            type="text"
            inputmode="text"
            autocapitalize="characters"
            autocomplete="one-time-code"
            maxlength="8"
            placeholder="XXXXXXXX"
            class="input input-bordered w-full text-center text-lg tracking-[0.3em] font-mono uppercase"
            :disabled="busy"
            @input="code = code.toUpperCase()"
          >
          <button
            type="submit"
            class="btn btn-primary w-full gap-2"
            :disabled="code.length !== 8 || busy"
          >
            <span v-if="busy" class="loading loading-spinner loading-xs" />
            {{ busy ? 'Connecting…' : 'Connect' }}
          </button>
        </form>

        <p class="text-xs text-base-content/50">
          Codes expire after 10 minutes and work once.
        </p>
      </div>
    </div>
  </div>
</template>

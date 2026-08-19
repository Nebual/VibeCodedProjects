<script setup lang="ts">
definePageMeta({ layout: false })

const { loggedIn } = useUserSession()
if (loggedIn.value) {
  await navigateTo('/')
}

const route = useRoute()
const oauthError = computed(() => route.query.error === 'oauth')
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-base-200 px-4">
    <div class="card w-full max-w-sm bg-base-100 shadow-xl">
      <div class="card-body items-center text-center gap-4">
        <h1 class="card-title text-2xl">Songtrack</h1>
        <p class="text-base-content/70">Record, tag, and share your piano takes.</p>
        <p v-if="oauthError" class="alert alert-error text-sm">
          Sign-in failed. Please try again.
        </p>
        <a href="/api/auth/google" class="btn btn-primary w-full">
          Sign in with Google
        </a>
      </div>
    </div>
  </div>
</template>

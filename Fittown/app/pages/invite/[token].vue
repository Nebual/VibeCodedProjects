<script setup lang="ts">
import { apiError } from '~/composables/useFriends'

/**
 * The other end of an invite link.
 *
 * Viewable signed out on purpose: whoever follows this may not have an account
 * yet, and being bounced straight to a Google button on a site you've been told
 * nothing about is how invitations get abandoned. The page says who invited you
 * first, then asks you to sign in.
 */
definePageMeta({ layout: 'public' })

const route = useRoute()
const { loggedIn } = useUserSession()

const token = computed(() => String(route.params.token))

interface InvitePreview {
  inviter: { id: number; name: string }
  usable: boolean
  problem: string | null
  expires_at: string
}

const { data, error } = await useFetch<InvitePreview>(
  () => `/api/friends/invites/${token.value}`,
)

useHead({ title: () => `Invite from ${data.value?.inviter.name ?? 'a friend'} · Fittown` })

const busy = ref(false)
const failure = ref<string | null>(null)
const accepted = ref(false)

async function accept() {
  busy.value = true
  failure.value = null
  try {
    await $fetch(`/api/friends/invites/${token.value}/accept`, { method: 'POST' })
    accepted.value = true
  } catch (err) {
    failure.value = apiError(err, 'Could not accept this invite')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="card bg-base-100 shadow-sm max-w-md mx-auto">
    <div class="card-body items-center text-center gap-4">
      <AppLogo class="w-12 h-12" />

      <template v-if="error">
        <h1 class="font-semibold text-lg">Invite not found</h1>
        <p class="text-sm text-base-content/60">
          This link doesn’t match an invitation. Ask for a fresh one.
        </p>
      </template>

      <template v-else-if="accepted">
        <h1 class="font-semibold text-lg">You’re friends with {{ data?.inviter.name }}</h1>
        <p class="text-sm text-base-content/60">
          You can see what they share, and they can see what you share.
        </p>
        <div class="flex gap-2">
          <NuxtLink to="/friends" class="btn btn-primary">Open Friends</NuxtLink>
          <NuxtLink to="/settings#sharing" class="btn btn-ghost">Choose what you share</NuxtLink>
        </div>
      </template>

      <template v-else-if="data && !data.usable">
        <h1 class="font-semibold text-lg">This link can’t be used</h1>
        <p class="text-sm text-base-content/60">{{ data.problem }}</p>
        <p class="text-sm text-base-content/60">
          Ask {{ data.inviter.name }} for a new one.
        </p>
      </template>

      <template v-else-if="data">
        <div>
          <h1 class="font-semibold text-lg">{{ data.inviter.name }} invited you</h1>
          <p class="text-sm text-base-content/60 mt-1">
            to share food, training and progress on Fittown.
          </p>
        </div>

        <p v-if="failure" class="text-sm text-error">{{ failure }}</p>

        <button v-if="loggedIn" class="btn btn-primary w-full" :disabled="busy" @click="accept">
          <span v-if="busy" class="loading loading-spinner loading-sm" />
          Accept
        </button>

        <template v-else>
          <NuxtLink
            :to="{ path: '/login', query: { redirect: route.fullPath } }"
            class="btn btn-primary w-full"
          >
            Sign in to accept
          </NuxtLink>
          <p class="text-xs text-base-content/50">
            You’ll come straight back here.
          </p>
        </template>

        <p class="text-xs text-base-content/40">
          Nothing of yours is shared until you choose it in Settings.
        </p>
      </template>
    </div>
  </div>
</template>

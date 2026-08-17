<script setup lang="ts">
import { friendDisplayName, friendInitial } from '#shared/friends'
import { apiError, type PendingRequest } from '~/composables/useFriends'

/**
 * "Alice wants to be your friend" — the prompt that makes adding someone by
 * email work without any notification infrastructure.
 *
 * Lives in the default layout, so it can appear on whatever screen the person
 * happens to open. Client-side only and polled rather than pushed: this is a
 * self-hosted app for one household, and a query every few minutes over an
 * indexed table costs less than a websocket costs to run.
 *
 * "Later" is remembered for the browsing session only. A request the user
 * dismissed is still a request, and it stays on the Friends tab; what would be
 * wrong is asking again on every single page load until they answer.
 */
const { loggedIn } = useUserSession()

/** Long enough not to be chatter, short enough that "I just sent it" works. */
const POLL_MS = 120_000
const DISMISSED_KEY = 'fittown.dismissedFriendRequests'

const pending = ref<PendingRequest[]>([])
const dismissed = ref<number[]>([])
const busy = ref(false)
const error = ref<string | null>(null)

const current = computed(() =>
  pending.value.find((request) => !dismissed.value.includes(request.friendship_id)),
)

async function poll() {
  if (!loggedIn.value) return
  try {
    const result = await $fetch<{ incoming: PendingRequest[] }>('/api/friends/pending')
    pending.value = result.incoming
  } catch {
    // A dropped connection or an expired session is not worth interrupting
    // whatever the user is doing; the next tick tries again.
  }
}

function readDismissed(): number[] {
  try {
    return JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]') as number[]
  } catch {
    return []
  }
}

function dismiss(id: number) {
  dismissed.value = [...dismissed.value, id]
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed.value))
  } catch {
    // Private-mode Safari refuses sessionStorage. Dismissal then lasts until
    // the page reloads, which is still better than not being able to close it.
  }
}

async function respond(request: PendingRequest, accept: boolean) {
  busy.value = true
  error.value = null
  try {
    await $fetch(`/api/friends/requests/${request.friendship_id}`, {
      method: accept ? 'PATCH' : 'DELETE',
    })
    pending.value = pending.value.filter((p) => p.friendship_id !== request.friendship_id)
  } catch (err) {
    error.value = apiError(err, 'Could not answer that request')
  } finally {
    busy.value = false
  }
}

let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  dismissed.value = readDismissed()
  poll()
  timer = setInterval(poll, POLL_MS)
})

onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <!--
    `modal-open` rather than a <dialog> call: the prompt is driven by data
    arriving, not by a click, and toggling a class keeps that in one place.
  -->
  <div v-if="current" class="modal modal-open modal-bottom sm:modal-middle z-50">
    <div class="modal-box">
      <h3 class="font-semibold text-lg">Friend request</h3>

      <div class="flex items-center gap-3 my-4">
        <div class="avatar avatar-placeholder">
          <div class="w-12 rounded-full bg-neutral text-neutral-content grid place-items-center">
            <img v-if="current.avatar_url" :src="current.avatar_url" :alt="current.name">
            <span v-else>{{ friendInitial(current) }}</span>
          </div>
        </div>
        <div class="min-w-0">
          <div class="font-medium truncate">{{ friendDisplayName(current) }}</div>
          <div class="text-xs text-base-content/60 truncate">{{ current.email }}</div>
        </div>
      </div>

      <p class="text-sm text-base-content/70">
        Accepting lets them see the trends and recipes you share, and lets you see
        theirs. You choose what that includes in Settings.
      </p>

      <p v-if="error" class="text-sm text-error mt-2">{{ error }}</p>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="dismiss(current.friendship_id)">
          Later
        </button>
        <button class="btn btn-outline btn-sm" :disabled="busy" @click="respond(current, false)">
          Decline
        </button>
        <button class="btn btn-primary btn-sm gap-2" :disabled="busy" @click="respond(current, true)">
          <span v-if="busy" class="loading loading-spinner loading-xs" />
          Accept
        </button>
      </div>
    </div>
  </div>
</template>

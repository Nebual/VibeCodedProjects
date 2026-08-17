<script setup lang="ts">
import { friendDisplayName, friendInitial, inviteUrl } from '#shared/friends'
import { apiError, type FriendsPayload, type InviteRow } from '~/composables/useFriends'

useHead({ title: 'Friends · Fittown' })

const { data, refresh } = await useFetch<FriendsPayload>('/api/friends', {
  default: () => ({ friends: [], incoming: [], outgoing: [], invites: [] }),
})

const busy = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

async function act(fn: () => Promise<unknown>, fallback: string) {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    await fn()
    await refresh()
  } catch (err) {
    error.value = apiError(err, fallback)
  } finally {
    busy.value = false
  }
}

// --- add by email -----------------------------------------------------------

const email = ref('')

function invite() {
  const address = email.value.trim()
  if (!address) return
  act(async () => {
    const result = await $fetch<{ status: string }>('/api/friends/requests', {
      method: 'POST',
      body: { email: address },
    })
    email.value = ''
    notice.value =
      result.status === 'accepted'
        ? 'You were already waiting on each other — you’re friends now.'
        : result.status === 'already_friends'
          ? 'You’re already friends.'
          : 'Request sent. They’ll see it next time they open Fittown.'
  }, 'Could not send that request')
}

// --- invite links -----------------------------------------------------------

/**
 * Built in the browser from the address bar rather than server-side.
 *
 * Deriving a public URL from request headers is guesswork behind a reverse
 * proxy — the same guesswork that broke Google sign-in once already (AGENTS.md
 * §6). The origin the user is looking at is right by construction.
 */
const origin = ref('')
onMounted(() => {
  origin.value = window.location.origin
})

function linkFor(invite: InviteRow) {
  return inviteUrl(origin.value, invite.token)
}

const copied = ref<string | null>(null)

async function copy(invite: InviteRow) {
  const url = linkFor(invite)
  try {
    await navigator.clipboard.writeText(url)
    copied.value = invite.token
    setTimeout(() => {
      if (copied.value === invite.token) copied.value = null
    }, 2000)
  } catch {
    // Clipboard access is refused on insecure origins and in some in-app
    // browsers. The URL is on screen in a selectable field either way.
    error.value = 'Couldn’t copy automatically — select the link and copy it.'
  }
}

const createInvite = () =>
  act(() => $fetch('/api/friends/invites', { method: 'POST', body: {} }), 'Could not create a link')

const revokeInvite = (token: string) =>
  act(
    () => $fetch(`/api/friends/invites/${token}`, { method: 'DELETE' }),
    'Could not cancel that link',
  )

// --- requests ---------------------------------------------------------------

const accept = (id: number) =>
  act(() => $fetch(`/api/friends/requests/${id}`, { method: 'PATCH' }), 'Could not accept')

const remove = (id: number) =>
  act(() => $fetch(`/api/friends/requests/${id}`, { method: 'DELETE' }), 'Could not do that')

/** Unfriending is quiet and permanent, so it asks first. */
const confirmingRemove = ref<number | null>(null)
</script>

<template>
  <div class="flex flex-col gap-3">
    <header class="flex items-center gap-2">
      <h1 class="font-semibold text-lg flex-1">Friends</h1>
      <span v-if="busy" class="loading loading-spinner loading-sm" />
    </header>

    <div v-if="error" class="alert alert-error text-sm py-2">{{ error }}</div>
    <div v-if="notice" class="alert alert-success text-sm py-2">
      <span class="flex-1">{{ notice }}</span>
      <button class="btn btn-ghost btn-xs btn-square" aria-label="Dismiss" @click="notice = null">
        <AppIcon name="x" class="w-4 h-4" />
      </button>
    </div>

    <!-- Waiting on you ------------------------------------------------------>
    <section v-if="data.incoming.length" class="card bg-base-100 shadow-sm">
      <div class="card-body p-0">
        <h2 class="px-4 pt-3 pb-1 font-semibold text-sm">Wants to be your friend</h2>
        <ul class="divide-y divide-base-200">
          <li
            v-for="person in data.incoming"
            :key="person.friendship_id"
            class="flex items-center gap-3 px-4 py-2.5"
          >
            <div class="avatar avatar-placeholder">
              <div class="w-9 rounded-full bg-neutral text-neutral-content grid place-items-center">
                <img v-if="person.avatar_url" :src="person.avatar_url" :alt="person.name">
                <span v-else class="text-sm">{{ friendInitial(person) }}</span>
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-sm truncate">{{ friendDisplayName(person) }}</div>
              <div class="text-xs text-base-content/60 truncate">{{ person.email }}</div>
            </div>
            <button
              class="btn btn-primary btn-sm"
              :disabled="busy"
              @click="accept(person.friendship_id)"
            >
              Accept
            </button>
            <button
              class="btn btn-ghost btn-sm btn-square"
              :aria-label="`Decline ${friendDisplayName(person)}`"
              :disabled="busy"
              @click="remove(person.friendship_id)"
            >
              <AppIcon name="x" class="w-4 h-4" />
            </button>
          </li>
        </ul>
      </div>
    </section>

    <!-- Your friends -------------------------------------------------------->
    <section class="card bg-base-100 shadow-sm overflow-hidden">
      <ul v-if="data.friends.length" class="divide-y divide-base-200">
        <li v-for="person in data.friends" :key="person.friendship_id" class="flex items-center">
          <NuxtLink
            :to="`/friends/${person.id}`"
            class="flex items-center gap-3 px-3 py-2.5 flex-1 min-w-0 hover:bg-base-200 transition-colors"
          >
            <div class="avatar avatar-placeholder">
              <div class="w-9 rounded-full bg-neutral text-neutral-content grid place-items-center">
                <img v-if="person.avatar_url" :src="person.avatar_url" :alt="person.name">
                <span v-else class="text-sm">{{ friendInitial(person) }}</span>
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-sm truncate">{{ friendDisplayName(person) }}</div>
              <div class="text-xs text-base-content/60 truncate">{{ person.email }}</div>
            </div>
            <AppIcon name="chevronRight" class="w-4 h-4 text-base-content/30 shrink-0" />
          </NuxtLink>
          <button
            v-if="confirmingRemove !== person.friendship_id"
            class="btn btn-ghost btn-xs btn-square mr-2 text-base-content/40 hover:text-error"
            :aria-label="`Remove ${friendDisplayName(person)}`"
            @click="confirmingRemove = person.friendship_id"
          >
            <AppIcon name="trash" class="w-4 h-4" />
          </button>
          <button
            v-else
            class="btn btn-error btn-xs mr-2"
            :disabled="busy"
            @click="remove(person.friendship_id); confirmingRemove = null"
          >
            Remove
          </button>
        </li>
      </ul>
      <p v-else class="p-6 text-center text-sm text-base-content/50">
        Friends can see the trends and recipes you choose to share, and you can see
        theirs. Nothing is shared until they accept.
      </p>
    </section>

    <!-- Add by email -------------------------------------------------------->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-2">
        <label class="form-control">
          <span class="label-text text-xs mb-1">Add a friend by email</span>
          <div class="flex gap-2">
            <input
              v-model="email"
              type="email"
              autocomplete="off"
              class="input input-bordered flex-1 min-w-0"
              placeholder="them@example.com"
              @keyup.enter="invite"
            >
            <button class="btn btn-primary gap-2" :disabled="busy || !email.trim()" @click="invite">
              <AppIcon name="plus" class="w-4 h-4" />
              Ask
            </button>
          </div>
        </label>
        <p class="text-xs text-base-content/50">
          They’ll get a prompt to accept next time they open Fittown.
        </p>

        <ul v-if="data.outgoing.length" class="text-sm divide-y divide-base-200 mt-1">
          <li
            v-for="person in data.outgoing"
            :key="person.friendship_id"
            class="flex items-center gap-2 py-1.5"
          >
            <span class="flex-1 min-w-0 truncate text-base-content/60">
              Waiting on {{ friendDisplayName(person) }}
            </span>
            <button
              class="btn btn-ghost btn-xs"
              :disabled="busy"
              @click="remove(person.friendship_id)"
            >
              Cancel
            </button>
          </li>
        </ul>
      </div>
    </section>

    <!-- Invite links -------------------------------------------------------->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <div class="flex items-center gap-2">
          <div class="flex-1">
            <h2 class="font-semibold text-sm">Invite by link</h2>
            <p class="text-xs text-base-content/50">
              For someone who hasn’t signed up yet. Anyone with the link can use it
              until you cancel it or it expires.
            </p>
          </div>
          <button class="btn btn-outline btn-sm gap-2" :disabled="busy" @click="createInvite">
            <AppIcon name="plus" class="w-4 h-4" />
            New link
          </button>
        </div>

        <ul v-if="data.invites.length" class="flex flex-col gap-2">
          <li v-for="link in data.invites" :key="link.token" class="flex flex-col gap-1">
            <div class="flex gap-2">
              <input
                class="input input-bordered input-sm flex-1 min-w-0 text-xs"
                :value="linkFor(link)"
                readonly
                :aria-label="`Invite link created ${link.created_at}`"
                @focus="($event.target as HTMLInputElement).select()"
              >
              <button class="btn btn-sm" @click="copy(link)">
                {{ copied === link.token ? 'Copied' : 'Copy' }}
              </button>
              <button
                class="btn btn-ghost btn-sm btn-square text-base-content/40 hover:text-error"
                aria-label="Cancel this link"
                :disabled="busy"
                @click="revokeInvite(link.token)"
              >
                <AppIcon name="trash" class="w-4 h-4" />
              </button>
            </div>
            <span class="text-[0.65rem] text-base-content/40 tabular">
              expires {{ link.expires_at.slice(0, 10) }}
            </span>
          </li>
        </ul>
      </div>
    </section>

    <NuxtLink to="/settings#sharing" class="btn btn-ghost btn-sm gap-2 self-start">
      <AppIcon name="cog" class="w-4 h-4" />
      Choose what friends can see
    </NuxtLink>
  </div>
</template>

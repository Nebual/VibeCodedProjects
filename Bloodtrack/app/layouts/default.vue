<template>
  <div class="navbar bg-base-200 shadow mb-4">
    <div class="flex-1 min-w-0">
      <NuxtLink to="/" class="btn btn-ghost text-xl px-2 gap-2">
        <img src="/icon.png" alt="Bloodtrack" class="w-7 h-7 rounded object-cover" />
        Bloodtrack
      </NuxtLink>
    </div>
    <div v-if="identity" class="flex-none flex items-center gap-1 sm:gap-2">
      <!-- compact identity on mobile -->
      <span class="hidden lg:inline text-sm opacity-70">Playing as <b>{{ identity.playerName }}</b></span>
      <span class="lg:hidden text-sm opacity-70"><b>{{ identity.playerName }}</b></span>

      <!-- direct shortcuts -->
      <NuxtLink :to="`/player/${identity.leagueId}`" class="btn btn-sm btn-ghost">My Matches</NuxtLink>
      <NuxtLink :to="`/standings/${identity.leagueId}`" class="btn btn-sm btn-ghost">Standings</NuxtLink>

      <!-- gear menu: rename + shortcuts -->
      <div class="dropdown dropdown-end">
        <div tabindex="0" role="button" class="btn btn-sm btn-circle btn-ghost" aria-label="Menu">⚙️</div>
        <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box z-[1] w-52 p-2 shadow-lg mt-2">
          <li>
            <button @click="renameOpen = true">
              ✏️ Rename myself
              <span class="badge badge-sm badge-ghost ml-auto">{{ identity.playerName }}</span>
            </button>
          </li>
          <li><button @click="logout()">Logout</button></li>
        </ul>
      </div>

      <button class="btn btn-sm btn-outline" @click="logout()">Logout</button>
    </div>
  </div>
  <main class="container mx-auto px-4 pb-10 max-w-full">
    <slot />
  </main>

  <!-- rename-myself dialog -->
  <dialog :open="renameOpen" class="modal modal-bottom sm:modal-middle">
    <div class="modal-box">
      <h3 class="font-bold text-lg">Rename yourself</h3>
      <p class="text-sm opacity-60 mb-3">This changes your name everywhere in the league.</p>
      <input
        v-model="newName"
        v-focus
        class="input input-bordered w-full"
        placeholder="New name…"
        maxlength="60"
        @keyup.enter="confirmRename"
      />
      <p v-if="renameError" class="text-error text-sm mt-2">{{ renameError }}</p>
      <div class="modal-action">
        <button class="btn btn-ghost" @click="renameOpen = false">Cancel</button>
        <button class="btn btn-primary" :disabled="!newName.trim() || renaming || newName.trim() === identity.playerName" @click="confirmRename">
          {{ renaming ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" @click="renameOpen = false"></button>
  </dialog>
</template>

<script setup lang="ts">
const { identity, logout } = useIdentity()

const vFocus = { mounted: (el: HTMLInputElement) => el.focus() }

const renameOpen = ref(false)
const newName = ref('')
const renaming = ref(false)
const renameError = ref('')

watch(renameOpen, (open) => {
  if (open && identity.value) {
    newName.value = identity.value.playerName
    renameError.value = ''
  }
})

async function confirmRename() {
  if (!identity.value) return
  const name = newName.value.trim()
  if (!name) return
  renaming.value = true
  renameError.value = ''
  try {
    await $fetch(`/api/leagues/${identity.value.leagueId}/players/${identity.value.playerId}`, {
      method: 'PATCH',
      body: { requesterId: identity.value.playerId, name },
    })
    // keep localStorage identity in sync with the new name
    identity.value = { ...identity.value, playerName: name }
    const raw = localStorage.getItem('bloodtrack.identity')
    if (raw) {
      const id = JSON.parse(raw)
      id.playerName = name
      localStorage.setItem('bloodtrack.identity', JSON.stringify(id))
    }
    renameOpen.value = false
  } catch (e: any) {
    renameError.value = e?.data?.statusMessage ?? 'Failed to rename'
  } finally {
    renaming.value = false
  }
}
</script>

<script setup lang="ts">
const { login } = useIdentity()

const { data: leagues, pending } = await useFetch<{ id: string; name: string; players: { id: string; name: string }[] }[]>(
  '/api/leagues',
)

// default-expand the newest league (last in list order)
const selectedLeagueId = ref<string | null>(
  leagues.value?.length ? leagues.value[leagues.value.length - 1].id : null,
)
const newLeagueName = ref('')
const creating = ref(false)

function selectLeague(id: string) {
  selectedLeagueId.value = selectedLeagueId.value === id ? null : id
}

async function playAs(leagueId: string, playerId: string, playerName: string) {
  login({ playerId, playerName, leagueId })
  // full navigation (not just navigateTo) so the player page re-mounts and
  // loads this player's matches fresh
  await navigateTo(`/player/${leagueId}`, { replace: true })
}

async function createLeague() {
  const name = newLeagueName.value.trim()
  if (!name) return
  creating.value = true
  try {
    const league = await $fetch<{ id: string }>('/api/leagues', {
      method: 'POST',
      body: { name },
    })
    navigateTo(`/admin/${league.id}`)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="max-w-2xl mx-auto space-y-6">
    <div class="hero bg-base-200 rounded-box p-8">
      <div class="hero-content text-center flex-col">
        <img src="/icon.png" alt="Bloodtrack" class="w-16 h-16 rounded-lg object-cover mx-auto" />
        <h1 class="text-4xl font-bold">Bloodtrack</h1>
        <p class="py-2 opacity-70">Blood Bowl league tracking — points, touchdowns &amp; casualties.</p>
      </div>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">Leagues</h2>
        <p class="text-sm opacity-70">Choose your league, then pick which player you are.</p>
        <div v-if="pending" class="loading loading-spinner"></div>
        <p v-else-if="!leagues?.length" class="opacity-60 py-4 text-center">No leagues yet — create one above.</p>
        <ul v-else class="list bg-base-200 rounded-box">
          <li v-for="league in leagues" :key="league.id" class="list-row block">
            <!-- header row -->
            <div
              class="flex items-center justify-between cursor-pointer w-full"
              @click="selectLeague(league.id)"
            >
              <div>
                <div class="font-semibold">{{ league.name }}</div>
                <div class="text-xs opacity-60">{{ league.players.length }} players</div>
              </div>
              <span class="btn btn-sm btn-ghost">{{ selectedLeagueId === league.id ? '▲' : '▼' }}</span>
            </div>

            <!-- expanded panel below the header -->
            <div v-if="selectedLeagueId === league.id" class="pt-3 pb-1">
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="player in league.players"
                  :key="player.id"
                  class="btn btn-sm btn-outline btn-secondary"
                  @click="playAs(league.id, player.id, player.name)"
                >
                  {{ player.name }}
                </button>
              </div>
              <p v-if="!league.players.length" class="text-xs opacity-60 mb-1">No players yet.</p>
              <NuxtLink :to="`/admin/${league.id}`" class="link link-hover text-xs opacity-60 mt-2 inline-block">
                Manage this league →
              </NuxtLink>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">League Admin</h2>
        <p class="text-sm opacity-70">Set up a league, add players and generate rounds.</p>
        <div class="join mt-2">
          <input v-model="newLeagueName" class="input input-bordered join-item w-full" placeholder="New league name…" @keyup.enter="createLeague" />
          <button class="btn btn-primary join-item" :disabled="creating || !newLeagueName.trim()" @click="createLeague">
            Create
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const leagueId = computed(() => String(route.params.leagueId))

type LeagueResponse = {
  id: string
  name: string
  players: { id: string; name: string }[]
  matches: {
    id: string
    round: number
    date?: string
    playerAId: string
    playerBId: string
    reported?: { result: string; touchdownsA: number; touchdownsB: number; casualtiesA: number; casualtiesB: number }
  }[]
}

const { data: league, refresh } = await useFetch<LeagueResponse>(`/api/leagues/${leagueId.value}`)

const playerName = (id: string) => league.value?.players.find((p) => p.id === id)?.name ?? '?'

const newPlayerName = ref('')
const addingPlayer = ref(false)
const generatingRound = ref(false)

async function addPlayer() {
  const name = newPlayerName.value.trim()
  if (!name) return
  addingPlayer.value = true
  try {
    await $fetch(`/api/leagues/${leagueId.value}/players`, { method: 'POST', body: { name } })
    newPlayerName.value = ''
    await refresh()
  } finally {
    addingPlayer.value = false
  }
}

async function generateRound() {
  generatingRound.value = true
  try {
    await $fetch(`/api/leagues/${leagueId.value}/rounds`, { method: 'POST', body: {} })
    await refresh()
  } finally {
    generatingRound.value = false
  }
}

function setMatchDate(matchId: string, ev: Event) {
  const date = (ev.target as HTMLInputElement).value
  if (!date) return
  // reuse report endpoint's date-only update path requires a full report; use a
  // lightweight PATCH via the same endpoint with reporterId of participant A
  const match = league.value?.matches.find((m) => m.id === matchId)
  if (!match) return
  $fetch(`/api/matches/${matchId}/report`, {
    method: 'POST',
    body: {
      reporterId: match.playerAId,
      ...(match.reported ?? { result: 'DRAW', touchdownsA: 0, touchdownsB: 0, casualtiesA: 0, casualtiesB: 0 }),
      ...match.reported,
      date,
    },
  }).then(refresh)
}

const rounds = computed(() => {
  const byRound = new Map<number, typeof matches>()
  const matches = league.value?.matches ?? []
  for (const m of [...matches].sort((a, b) => a.round - b.round)) {
    if (!byRound.has(m.round)) byRound.set(m.round, [])
    byRound.get(m.round)!.push(m)
  }
  return [...byRound.entries()].map(([round, ms]) => ({
    round,
    matches: [...ms].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999')),
  }))
})
</script>

<template>
  <div v-if="league" class="max-w-3xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold">{{ league.name }} — Admin</h1>
      <NuxtLink :to="`/standings/${league.id}`" class="btn btn-sm btn-outline">Standings</NuxtLink>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">Players ({{ league.players.length }})</h2>
        <div class="join mb-2">
          <input v-model="newPlayerName" class="input input-bordered join-item w-full max-w-xs" placeholder="Player name…" @keyup.enter="addPlayer" />
          <button class="btn btn-primary join-item" :disabled="addingPlayer || !newPlayerName.trim()" @click="addPlayer">Add</button>
        </div>
        <div class="flex flex-wrap gap-2">
          <span v-for="p in league.players" :key="p.id" class="badge badge-outline badge-lg">{{ p.name }}</span>
        </div>
      </div>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">Rounds &amp; Fixtures</h2>
        <button class="btn btn-secondary w-fit" :disabled="generatingRound || league.players.length < 2" @click="generateRound">
          {{ generatingRound ? 'Generating…' : `Generate Round ${Math.max(0, ...league.matches.map(m => m.round), 0) + 1}` }}
        </button>

        <p v-if="!league.matches.length" class="opacity-60 py-4 text-center">No rounds yet.</p>

        <div v-for="r in rounds" :key="r.round" class="mt-4">
          <h3 class="font-semibold opacity-80 mb-2">Round {{ r.round }}</h3>
          <ul class="list bg-base-200 rounded-box">
            <li v-for="m in r.matches" :key="m.id" class="list-row items-center gap-4 flex-wrap">
              <span class="font-medium">{{ playerName(m.playerAId) }}</span>
              <span class="opacity-50">vs</span>
              <span class="font-medium">{{ playerName(m.playerBId) }}</span>
              <input type="date" class="input input-xs input-bordered" :value="m.date" @change="(e) => setMatchDate(m.id, e)" />
              <span v-if="m.reported" class="badge badge-success badge-sm whitespace-nowrap">
                {{ m.reported.touchdownsA }}–{{ m.reported.touchdownsB }} TD,
                {{ m.reported.casualtiesA }}–{{ m.reported.casualtiesB }} CAS
              </span>
              <span v-else class="badge badge-ghost badge-sm">Not reported</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
  <p v-else class="text-center opacity-60 py-10">League not found.</p>
</template>

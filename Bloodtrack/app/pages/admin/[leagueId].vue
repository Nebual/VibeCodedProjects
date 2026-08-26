<script setup lang="ts">
import type { MatchView } from '~~/shared/matches'

const route = useRoute()
const leagueId = computed(() => String(route.params.leagueId))

type MatchRow = {
  id: string
  round: number
  date?: string
  playerAId: string
  playerBId: string
  reported?: { result: string; touchdownsA: number; touchdownsB: number; casualtiesA: number; casualtiesB: number }
}

const { data: league, refresh } = await useFetch<{
  id: string
  name: string
  players: { id: string; name: string }[]
  matches: MatchRow[]
}>(`/api/leagues/${leagueId.value}`)

const playerName = (id: string) => league.value?.players.find((p) => p.id === id)?.name ?? '?'

const newPlayerName = ref('')
const addingPlayer = ref(false)
const generatingSchedule = ref(false)
const scheduleStart = ref('')

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

/** Generates the FULL round-robin (N-1 rounds, no repeated matchups). */
async function generateSchedule() {
  generatingSchedule.value = true
  try {
    await $fetch(`/api/leagues/${leagueId.value}/rounds`, {
      method: 'POST',
      body: {
        ...(scheduleStart.value ? { startDate: scheduleStart.value, daysPerRound: 14 } : {}),
      },
    })
    await refresh()
  } finally {
    generatingSchedule.value = false
  }
}

function setMatchDate(matchId: string, ev: Event) {
  const date = (ev.target as HTMLInputElement).value
  if (!date) return
  const match = league.value?.matches.find((m) => m.id === matchId)
  if (!match) return
  $fetch(`/api/matches/${matchId}/report`, {
    method: 'POST',
    body: {
      reporterId: '__admin__',
      ...(match.reported ?? { result: 'DRAW', touchdownsA: 0, touchdownsB: 0, casualtiesA: 0, casualtiesB: 0 }),
      date,
    },
  }).then(refresh)
}

const rounds = computed(() => {
  const matches = league.value?.matches ?? []
  const byRound = new Map<number, MatchRow[]>()
  for (const m of [...matches].sort((a, b) => a.round - b.round)) {
    if (!byRound.has(m.round)) byRound.set(m.round, [])
    byRound.get(m.round)!.push(m)
  }
  return [...byRound.entries()].map(([round, ms]) => ({
    round,
    matches: [...ms].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999')),
  }))
})

// admin can open the report form for ANY match
const selectedMatchId = ref<string | null>(null)
const selectedMatch = computed<MatchView | null>(() => {
  const m = league.value?.matches.find((x) => x.id === selectedMatchId.value)
  if (!m) return null
  return {
    id: m.id,
    round: m.round,
    date: m.date,
    reported: !!m.reported,
    playerA: { id: m.playerAId, name: playerName(m.playerAId) },
    playerB: { id: m.playerBId, name: playerName(m.playerBId) },
    result: m.reported?.result as MatchView['result'],
    touchdownsA: m.reported?.touchdownsA,
    touchdownsB: m.reported?.touchdownsB,
    casualtiesA: m.reported?.casualtiesA,
    casualtiesB: m.reported?.casualtiesB,
  }
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
        <h2 class="card-title">Full Schedule</h2>
        <p class="text-sm opacity-70">
          Generates all {{ Math.max(league.players.length - 1, 0) }} rounds (round-robin): every player meets every other exactly once.
          Existing matchups are never duplicated — safe to run again after adding players.
        </p>
        <div class="join w-fit">
          <input v-model="scheduleStart" type="date" class="input input-bordered join-item" />
          <button class="btn btn-secondary join-item" :disabled="generatingSchedule || league.players.length < 2" @click="generateSchedule">
            {{ generatingSchedule ? 'Generating…' : league.matches.length ? 'Generate remaining rounds' : 'Generate full schedule' }}
          </button>
        </div>

        <p v-if="!league.matches.length" class="opacity-60 py-4 text-center">No rounds yet.</p>

        <div v-for="r in rounds" :key="r.round" class="mt-4">
          <h3 class="font-semibold opacity-80 mb-2">Round {{ r.round }}</h3>
          <ul class="list bg-base-200 rounded-box">
            <li v-for="m in r.matches" :key="m.id" class="list-row items-center gap-4 flex-wrap">
              <span class="font-medium cursor-pointer hover:underline" @click="selectedMatchId = selectedMatchId === m.id ? null : m.id">
                {{ playerName(m.playerAId) }} <span class="opacity-50">vs</span> {{ playerName(m.playerBId) }}
              </span>
              <input type="date" class="input input-xs input-bordered" :value="m.date" @change="(e) => setMatchDate(m.id, e)" />
              <span v-if="m.reported" class="badge badge-success badge-sm whitespace-nowrap">
                {{ m.reported.touchdownsA }}–{{ m.reported.touchdownsB }} TD,
                {{ m.reported.casualtiesA }}–{{ m.reported.casualtiesB }} CAS
              </span>
              <span v-else class="badge badge-ghost badge-sm">Not reported</span>
              <button class="btn btn-xs btn-primary" @click="selectedMatchId = selectedMatchId === m.id ? null : m.id">
                {{ selectedMatchId === m.id ? 'Close' : 'Enter stats' }}
              </button>
            </li>
          </ul>

          <MatchReportForm
            v-if="selectedMatch && r.matches.some(m => m.id === selectedMatch.id)"
            :match="selectedMatch"
            reporter-id="__admin__"
            class="mt-3"
            @submitted="async () => { await refresh(); }"
          />
        </div>
      </div>
    </div>
  </div>
  <p v-else class="text-center opacity-60 py-10">League not found.</p>
</template>

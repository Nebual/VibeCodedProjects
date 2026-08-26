<script setup lang="ts">
const route = useRoute()
const { identity } = useIdentity()
const leagueId = computed(() => String(route.params.leagueId))

if (!identity.value || identity.value.leagueId !== leagueId.value) {
  await navigateTo('/', { replace: true })
}

const myPlayerId = computed(() => identity.value!.playerId)

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
    reported?: {
      result: 'A_WIN' | 'B_WIN' | 'DRAW'
      touchdownsA: number
      touchdownsB: number
      casualtiesA: number
      casualtiesB: number
    }
  }[]
}

const { data: league, refresh } = await useFetch<LeagueResponse>(`/api/leagues/${leagueId.value}`)

const playerName = (id: string) => league.value?.players.find((p) => p.id === id)?.name ?? '?'

type Round = { round: number; date?: string; reported: boolean; playerAId: string; playerBId: string }

const myRounds = computed(() => {
  const byRound = new Map<number, Round[]>()
  for (const m of [...(league.value?.matches ?? [])].sort((a, b) => a.round - b.round)) {
    if (!byRound.has(m.round)) byRound.set(m.round, [])
    byRound.get(m.round)!.push(m)
  }
  return [...byRound.entries()].map(([round, ms]) => ({
    round,
    matches: [...ms].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999')),
  }))
})

const selectedMatchId = ref<string | null>(null)
const selectedMatch = computed(() => {
  const m = league.value?.matches.find((x) => x.id === selectedMatchId.value)
  if (!m) return null
  return {
    ...m,
    playerA: { id: m.playerAId, name: playerName(m.playerAId) },
    playerB: { id: m.playerBId, name: playerName(m.playerBId) },
    result: m.reported?.result,
    touchdownsA: m.reported?.touchdownsA,
    touchdownsB: m.reported?.touchdownsB,
    casualtiesA: m.reported?.casualtiesA,
    casualtiesB: m.reported?.casualtiesB,
  }
})
</script>

<template>
  <div v-if="league" class="max-w-2xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold">{{ league.name }}</h1>
      <NuxtLink :to="`/standings/${league.id}`" class="btn btn-sm btn-outline">Standings</NuxtLink>
    </div>

    <p v-if="!league.matches.length" class="opacity-60 text-center py-10">
      No rounds scheduled yet — the admin hasn't generated any matchups.
    </p>

    <div v-for="r in myRounds" :key="r.round" class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">Round {{ r.round }}</h2>
        <ul class="list bg-base-200 rounded-box">
          <li v-for="m in r.matches" :key="m.id" class="list-row items-center gap-3">
            <div class="flex-1 cursor-pointer" @click="selectedMatchId = selectedMatchId === m.id ? null : m.id">
              <span class="font-medium">{{ playerName(m.playerAId) }}</span>
              <span class="opacity-50"> vs </span>
              <span class="font-medium">{{ playerName(m.playerBId) }}</span>
              <div class="text-xs opacity-60 flex gap-2 items-center">
                <span v-if="m.date">{{ m.date }}</span>
                <span v-if="m.reported" class="badge badge-success badge-xs">
                  {{ m.reported.touchdownsA }}–{{ m.reported.touchdownsB }} TD · {{ m.reported.casualtiesA }}–{{ m.reported.casualtiesB }} CAS
                </span>
                <span v-else class="badge badge-ghost badge-xs">Not reported</span>
                <span v-if="m.playerAId === myPlayerId || m.playerBId === myPlayerId" class="badge badge-secondary badge-xs">Your match</span>
              </div>
            </div>
            <button
              v-if="m.playerAId === myPlayerId || m.playerBId === myPlayerId"
              class="btn btn-sm btn-primary"
              @click="selectedMatchId = selectedMatchId === m.id ? null : m.id"
            >
              {{ selectedMatchId === m.id ? 'Close' : 'Report' }}
            </button>
          </li>
        </ul>

        <MatchReportForm
          v-if="selectedMatch && (selectedMatch.playerAId === myPlayerId || selectedMatch.playerBId === myPlayerId)"
          :match="selectedMatch"
          :reporter-id="myPlayerId"
          @submitted="async () => { await refresh(); selectedMatchId = null }"
        />
      </div>
    </div>
  </div>
</template>

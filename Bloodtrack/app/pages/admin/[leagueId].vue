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

const addPlayerError = ref('')

async function addPlayer() {
  const name = newPlayerName.value.trim()
  if (!name) return
  addingPlayer.value = true
  addPlayerError.value = ''
  try {
    await $fetch(`/api/leagues/${leagueId.value}/players`, { method: 'POST', body: { name } })
    newPlayerName.value = ''
    await refresh()
  } catch (e: any) {
    addPlayerError.value = e?.data?.statusMessage ?? 'Failed to add player'
  } finally {
    addingPlayer.value = false
  }
}

const scheduleError = ref('')

/** Generates the FULL round-robin (N-1 rounds, no repeated matchups). */
async function generateSchedule() {
  generatingSchedule.value = true
  scheduleError.value = ''
  try {
    await $fetch(`/api/leagues/${leagueId.value}/rounds`, {
      method: 'POST',
      body: {
        ...(scheduleStart.value ? { startDate: scheduleStart.value, daysPerRound: 14 } : {}),
      },
    })
    await refresh()
  } catch (e: any) {
    scheduleError.value = e?.data?.statusMessage ?? 'Failed to generate schedule'
  } finally {
    generatingSchedule.value = false
  }
}

const dateError = ref('')

async function setMatchDate(matchId: string, ev: Event) {
  const date = (ev.target as HTMLInputElement).value
  dateError.value = ''
  try {
    // dedicated date endpoint — never fabricates a match report
    await $fetch(`/api/matches/${matchId}/date`, {
      method: 'PATCH',
      body: { date: date || null, requesterId: '__admin__' },
    })
    await refresh()
  } catch (e: any) {
    dateError.value = e?.data?.statusMessage ?? 'Failed to set date'
    await refresh() // restore the input to the stored value
  }
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

// --- rename (admin may rename anyone) ---
type RenameTarget = { id: string; name: string }
const renameOpen = ref(false)
const renameTarget = ref<RenameTarget | null>(null)
const renameValue = ref('')
const renameError = ref('')
const renaming = ref(false)

function openRename(p: RenameTarget) {
  renameTarget.value = p
  renameValue.value = p.name
  renameError.value = ''
  renameOpen.value = true
}

async function confirmRename() {
  const name = renameValue.value.trim()
  if (!renameTarget.value || !name || name === renameTarget.value.name) {
    renameOpen.value = false
    return
  }
  renaming.value = true
  renameError.value = ''
  try {
    await $fetch(`/api/leagues/${leagueId.value}/players/${renameTarget.value.id}`, {
      method: 'PATCH',
      body: { requesterId: '__admin__', name },
    })
    renameOpen.value = false
    await refresh()
  } catch (e: any) {
    renameError.value = e?.data?.statusMessage ?? 'Failed to rename'
  } finally {
    renaming.value = false
  }
}
</script>

<template>
  <div v-if="league" class="max-w-3xl mx-auto space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h1 class="text-3xl font-bold">{{ league.name }} — Admin</h1>
      <NuxtLink :to="`/standings/${league.id}`" class="btn btn-sm btn-outline">Standings</NuxtLink>
    </div>

    <div class="card bg-base-100 shadow max-sm:bg-transparent max-sm:shadow-none">
      <div class="card-body max-sm:p-0 max-sm:py-2">
        <h2 class="card-title text-lg">Players ({{ league.players.length }})</h2>
        <div class="join mb-2 max-w-full sm:max-w-xs">
          <input v-model="newPlayerName" class="input input-bordered join-item w-full min-w-0" placeholder="Player name…" @keyup.enter="addPlayer" />
          <button class="btn btn-primary join-item shrink-0" :disabled="addingPlayer || !newPlayerName.trim()" @click="addPlayer">Add</button>
        </div>
        <p v-if="addPlayerError" class="text-error text-sm mt-1">{{ addPlayerError }}</p>
        <!-- editable name badges: click to rename (admin) -->
        <div class="flex flex-wrap gap-2">
          <span
            v-for="p in league.players"
            :key="p.id"
            class="badge badge-outline badge-lg cursor-pointer hover:badge-primary"
            :title="'Rename ' + p.name"
            @click="openRename(p)"
          >
            {{ p.name }}
          </span>
        </div>
        <p class="text-xs opacity-50 mt-1">Tap a player to rename them.</p>
      </div>
    </div>

    <div class="card bg-base-100 shadow max-sm:bg-transparent max-sm:shadow-none">
      <div class="card-body max-sm:p-0 max-sm:py-2">
        <h2 class="card-title text-lg">Full Schedule</h2>
        <p class="text-sm opacity-70">
          Generates all {{ Math.max(league.players.length - 1, 0) }} rounds (round-robin): every player meets every other exactly once.
          Existing matchups are never duplicated — safe to run again after adding players.
        </p>
        <div class="join w-full sm:w-fit max-sm:flex-col max-sm:[&>*]:w-full max-sm:join-vertical">
          <input v-model="scheduleStart" type="date" class="input input-bordered join-item max-sm:border-t-0 max-sm:border-b-0" />
          <button class="btn btn-secondary join-item whitespace-nowrap" :disabled="generatingSchedule || league.players.length < 2" @click="generateSchedule">
            {{ generatingSchedule ? 'Generating…' : league.matches.length ? 'Generate remaining rounds' : 'Generate full schedule' }}
          </button>
        </div>
        <p v-if="scheduleError" class="text-error text-sm">{{ scheduleError }}</p>

        <p v-if="!league.matches.length" class="opacity-60 py-4 text-center">No rounds yet.</p>

        <div v-for="r in rounds" :key="r.round" class="mt-4">
          <h3 class="font-semibold opacity-80 mb-2">Round {{ r.round }}</h3>
          <ul class="list bg-base-200 rounded-box">
            <li v-for="m in r.matches" :key="m.id" class="list-row items-start gap-x-3 gap-y-1 flex-wrap relative pl-6 py-3">
              <!-- floating reported dot -->
              <span
                class="absolute left-1 top-4 h-2.5 w-2.5 rounded-full"
                :class="m.reported ? 'bg-success' : 'bg-base-content/20'"
                :title="m.reported ? 'Reported' : 'Not reported'"
              ></span>
              <div class="min-w-0 basis-full sm:basis-auto grow cursor-pointer" @click="selectedMatchId = selectedMatchId === m.id ? null : m.id">
                <div class="font-medium leading-snug break-words">
                  {{ playerName(m.playerAId) }} <span class="opacity-50">vs</span> {{ playerName(m.playerBId) }}
                </div>
                <div v-if="m.reported" class="text-xs opacity-60 whitespace-nowrap">
                  {{ m.reported.touchdownsA }}–{{ m.reported.touchdownsB }} TD · {{ m.reported.casualtiesA }}–{{ m.reported.casualtiesB }} CAS
                </div>
              </div>
              <label class="flex items-center gap-1 text-xs opacity-60 shrink-0">
                <input type="date" class="input input-xs input-bordered w-[8.5rem]" :value="m.date" @change="(e) => setMatchDate(m.id, e)" />
              </label>
              <button class="btn btn-xs btn-primary shrink-0 whitespace-nowrap px-2.5" @click="selectedMatchId = selectedMatchId === m.id ? null : m.id">
                {{ selectedMatchId === m.id ? 'Close' : 'Stats' }}
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
  <p v-if="dateError" class="text-error text-sm text-center">{{ dateError }}</p>

  <!-- rename dialog -->
  <dialog :open="renameOpen" class="modal modal-bottom sm:modal-middle">
    <div class="modal-box">
      <h3 class="font-bold text-lg">Rename player</h3>
      <p class="text-sm opacity-60 mb-3">Renaming <b>{{ renameTarget?.name }}</b></p>
      <input v-model="renameValue" class="input input-bordered w-full" placeholder="New name…" maxlength="60" @keyup.enter="confirmRename" />
      <p v-if="renameError" class="text-error text-sm mt-2">{{ renameError }}</p>
      <div class="modal-action">
        <button class="btn btn-ghost" @click="renameOpen = false">Cancel</button>
        <button class="btn btn-primary" :disabled="!renameValue.trim() || renaming" @click="confirmRename">
          {{ renaming ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" @click="renameOpen = false"></button>
  </dialog>
</template>

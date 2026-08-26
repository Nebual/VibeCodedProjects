<script setup lang="ts">
const route = useRoute()
const leagueId = computed(() => String(route.params.leagueId))

const { data: league } = await useFetch<{
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
}>(`/api/leagues/${leagueId.value}`)

// A round is "complete" when every match in it has been reported.
// By default standings only count complete rounds so a player who has played
// more games isn't unfairly ahead of one with fewer games done.
const includeIncomplete = ref(false)

const rounds = computed(() => {
  const byRound = new Map<number, { complete: boolean; matches: typeof matches }>()
  const matches = league.value?.matches ?? []
  for (const m of matches) {
    if (!byRound.has(m.round)) byRound.set(m.round, { complete: true, matches: [] })
    const r = byRound.get(m.round)!
    if (!m.reported) r.complete = false
    r.matches.push(m)
  }
  return byRound
})

const includedRounds = computed(() => {
  const out = new Set<number>()
  for (const [round, info] of rounds.value) {
    if (includeIncomplete.value || info.complete) out.add(round)
  }
  return out
})

const allComplete = computed(
  () => [...rounds.value.values()].every((r) => r.complete),
)
const hasIncomplete = computed(
  () => [...rounds.value.values()].some((r) => !r.complete),
)
const completedRoundCount = computed(
  () => [...rounds.value.values()].filter((r) => r.complete).length,
)

const standings = computed(() => {
  const table = new Map<string, any>()
  for (const p of league.value?.players ?? []) {
    table.set(p.id, {
      playerId: p.id,
      name: p.name,
      played: 0, wins: 0, draws: 0, losses: 0,
      touchdowns: 0, casualties: 0, points: 0,
    })
  }
  for (const m of league.value?.matches ?? []) {
    if (!m.reported || !includedRounds.value.has(m.round)) continue
    const a = table.get(m.playerAId)
    const b = table.get(m.playerBId)
    if (!a || !b) continue
    const r = m.reported
    a.played++; b.played++
    a.touchdowns += r.touchdownsA
    b.touchdowns += r.touchdownsB
    a.casualties += r.casualtiesA
    b.casualties += r.casualtiesB
    if (r.result === 'A_WIN') { a.wins++; a.points += 3; b.losses++ }
    else if (r.result === 'B_WIN') { b.wins++; b.points += 3; a.losses++ }
    else { a.draws++; b.draws++; a.points++; b.points++ }
  }
  return [...table.values()].sort(
    (x, y) =>
      y.points - x.points ||
      y.touchdowns - x.touchdowns ||
      y.casualties - x.casualties ||
      x.name.localeCompare(y.name),
  )
})
</script>

<template>
  <div class="max-w-2xl mx-auto">
    <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
      <h1 class="text-3xl font-bold">Standings</h1>
      <label v-if="hasIncomplete && !allComplete" class="label cursor-pointer gap-2">
        <span class="label-text text-sm opacity-70">
          {{ includeIncomplete ? 'Showing all rounds' : `Completed rounds only (${completedRoundCount}/${rounds.size})` }}
        </span>
        <input v-model="includeIncomplete" type="checkbox" class="toggle toggle-primary toggle-sm" />
      </label>
    </div>

    <p v-if="!standings.length" class="opacity-60 text-center py-10">No players yet.</p>
    <template v-else>
      <table class="table table-zebra bg-base-100 shadow rounded-box table-sm sm:table-md">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th v-if="includeIncomplete" title="Rounds played">Rounds</th>
            <th>Win</th>
            <th>Tie</th>
            <th class="max-sm:hidden">Loss</th>
            <th title="Touchdowns">TD</th>
            <th title="Casualties">CAS</th>
            <th>Pts</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in standings" :key="row.playerId" :class="{ 'bg-primary/10': i === 0 && row.played > 0 }">
            <td>{{ i + 1 }}</td>
            <td class="font-medium">{{ row.name }}</td>
            <td v-if="includeIncomplete">{{ row.played }}</td>
            <td>{{ row.wins }}</td>
            <td>{{ row.draws }}</td>
            <td class="max-sm:hidden">{{ row.losses }}</td>
            <td>{{ row.touchdowns }}</td>
            <td>{{ row.casualties }}</td>
            <td class="font-bold">{{ row.points }}</td>
          </tr>
        </tbody>
      </table>
      <p class="text-xs opacity-50 mt-2">
        Ties broken by touchdowns, then casualties.
        <template v-if="!includeIncomplete && hasIncomplete && !allComplete">
          Incomplete rounds are excluded — use the toggle above to include them.
        </template>
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const leagueId = computed(() => String(route.params.leagueId))

const { data: standings } = await useFetch<
  { playerId: string; name: string; played: number; wins: number; draws: number; losses: number; touchdowns: number; casualties: number; points: number }[]
>(`/api/leagues/${leagueId.value}/standings`)
</script>

<template>
  <div class="max-w-2xl mx-auto">
    <h1 class="text-3xl font-bold mb-4">Standings</h1>
    <p v-if="!standings?.length" class="opacity-60 text-center py-10">No players yet.</p>
    <table v-else class="table table-zebra bg-base-100 shadow rounded-box">
      <thead>
        <tr>
          <th>#</th>
          <th>Player</th>
          <th>P</th>
          <th>W</th>
          <th>D</th>
          <th>L</th>
          <th>TD</th>
          <th>CAS</th>
          <th>Pts</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in standings" :key="row.playerId" :class="{ 'bg-primary/10': i === 0 && row.played > 0 }">
          <td>{{ i + 1 }}</td>
          <td class="font-medium">{{ row.name }}</td>
          <td>{{ row.played }}</td>
          <td>{{ row.wins }}</td>
          <td>{{ row.draws }}</td>
          <td>{{ row.losses }}</td>
          <td>{{ row.touchdowns }}</td>
          <td>{{ row.casualties }}</td>
          <td class="font-bold">{{ row.points }}</td>
        </tr>
      </tbody>
    </table>
    <p class="text-xs opacity-50 mt-2">Ties broken by touchdowns, then casualties.</p>
  </div>
</template>

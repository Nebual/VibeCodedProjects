<script setup lang="ts">
import type { Goals } from '~/composables/useDiary'
import { addDays, fromLocalDate } from '~/utils/dates'

useHead({ title: 'Trends · Fittown' })

const range = ref(14)
const today = useToday()
const to = computed(() => today.value)
const from = computed(() => (today.value ? addDays(today.value, -(range.value - 1)) : null))

interface Summary {
  food: Record<string, { kcal: number | null; protein_g: number | null }>
  water: Record<string, { total_ml: number }>
  workouts: Record<string, { calories: number | null; minutes: number | null }>
  weights: { date: string; weight_kg: number }[]
  goals: Goals
}

const { data } = await useFetch<Summary>('/api/summary', {
  query: { from, to },
  watch: [from, to],
  immediate: !!today.value,
  server: !!today.value,
})

/** Walk every day in the range so gaps render as gaps, not as missing bars. */
const days = computed(() => {
  const out = []
  if (!from.value) return out
  for (let i = 0; i < range.value; i++) {
    const date = addDays(from.value, i)
    out.push({
      date,
      label: fromLocalDate(date).toLocaleDateString(undefined, { weekday: 'narrow' }),
      kcal: Math.round(data.value?.food[date]?.kcal ?? 0),
      water: Math.round(data.value?.water[date]?.total_ml ?? 0),
      burned: Math.round(data.value?.workouts[date]?.calories ?? 0),
    })
  }
  return out
})

const goal = computed(() => data.value?.goals?.calorie_goal ?? 2000)
const maxKcal = computed(() =>
  Math.max(goal.value, ...days.value.map((d) => d.kcal)) * 1.1,
)

const logged = computed(() => days.value.filter((d) => d.kcal > 0))
const avgKcal = computed(() =>
  logged.value.length
    ? Math.round(logged.value.reduce((s, d) => s + d.kcal, 0) / logged.value.length)
    : 0,
)
const totalBurned = computed(() => days.value.reduce((s, d) => s + d.burned, 0))
const weights = computed(() => data.value?.weights ?? [])
const weightChange = computed(() => {
  const w = weights.value
  if (w.length < 2) return null
  return w[w.length - 1]!.weight_kg - w[0]!.weight_kg
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-2">
      <h1 class="font-semibold text-lg flex-1">Trends</h1>
      <div role="tablist" class="tabs tabs-box tabs-xs">
        <button
          v-for="r in [7, 14, 30]" :key="r"
          role="tab" class="tab" :class="{ 'tab-active': range === r }"
          @click="range = r"
        >{{ r }}d</button>
      </div>
    </div>

    <div class="stats stats-horizontal bg-base-100 shadow-sm w-full">
      <div class="stat p-3">
        <div class="stat-title text-xs">Avg intake</div>
        <div class="stat-value text-xl tabular">{{ avgKcal }}</div>
        <div class="stat-desc text-xs">kcal · {{ logged.length }} days logged</div>
      </div>
      <div class="stat p-3">
        <div class="stat-title text-xs">Burned</div>
        <div class="stat-value text-xl tabular text-success">{{ totalBurned }}</div>
        <div class="stat-desc text-xs">kcal from training</div>
      </div>
      <div v-if="weightChange !== null" class="stat p-3">
        <div class="stat-title text-xs">Weight</div>
        <div class="stat-value text-xl tabular">
          {{ weightChange > 0 ? '+' : '' }}{{ weightChange.toFixed(1) }}
        </div>
        <div class="stat-desc text-xs">kg over range</div>
      </div>
    </div>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold text-sm">Calories</h2>

        <div class="relative h-40">
          <!-- Goal line -->
          <div
            class="absolute inset-x-0 border-t border-dashed border-primary/50 z-10"
            :style="`bottom:${(goal / maxKcal) * 100}%`"
          >
            <span class="absolute -top-4 right-0 text-[0.6rem] text-primary/70 tabular">
              goal {{ goal }}
            </span>
          </div>

          <div class="flex items-end gap-1 h-full">
            <div
              v-for="d in days"
              :key="d.date"
              class="flex-1 flex flex-col justify-end h-full group relative"
            >
              <div
                class="rounded-t transition-all"
                :class="d.kcal > goal ? 'bg-error/70' : 'bg-primary/70'"
                :style="`height:${Math.max(d.kcal > 0 ? 2 : 0, (d.kcal / maxKcal) * 100)}%`"
              />
              <div class="absolute -top-5 left-1/2 -translate-x-1/2 hidden group-hover:block text-[0.6rem] tabular bg-neutral text-neutral-content px-1 rounded whitespace-nowrap z-20">
                {{ d.kcal }}
              </div>
            </div>
          </div>
        </div>

        <div class="flex gap-1">
          <div
            v-for="d in days" :key="d.date"
            class="flex-1 text-center text-[0.6rem] text-base-content/40"
          >{{ d.label }}</div>
        </div>
      </div>
    </section>

    <section v-if="weights.length > 1" class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-2">
        <h2 class="font-semibold text-sm">Weight</h2>
        <ul class="text-sm divide-y divide-base-200">
          <li v-for="w in weights.slice().reverse()" :key="w.date" class="flex justify-between py-1.5">
            <span class="text-base-content/60">{{ w.date }}</span>
            <span class="tabular">{{ w.weight_kg }} kg</span>
          </li>
        </ul>
      </div>
    </section>

    <p v-if="!logged.length" class="text-center text-sm text-base-content/50 py-8">
      Log some food to see trends here.
    </p>
  </div>
</template>

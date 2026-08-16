<script setup lang="ts">
import type { Goals } from '~/composables/useDiary'
import { formatWeight, kgToLb } from '#shared/body'
import { addDays, fromLocalDate } from '~/utils/dates'

useHead({ title: 'Trends · Fittown' })

/** 365 rather than 366: a "year" here is the last 52 weeks, evenly bucketed. */
const RANGES = [
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
  { days: 365, label: '1y' },
]

const range = ref(14)
const isYear = computed(() => range.value >= 365)

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

const unit = computed(() => data.value?.goals?.weight_unit ?? 'kg')

/** Walk every day in the range so gaps render as gaps, not as missing bars. */
const days = computed(() => {
  const out: { date: string; kcal: number; water: number; burned: number }[] = []
  if (!from.value) return out
  for (let i = 0; i < range.value; i++) {
    const date = addDays(from.value, i)
    out.push({
      date,
      kcal: Math.round(data.value?.food[date]?.kcal ?? 0),
      water: Math.round(data.value?.water[date]?.total_ml ?? 0),
      burned: Math.round(data.value?.workouts[date]?.calories ?? 0),
    })
  }
  return out
})

/**
 * Bars to draw. A year is 365 days and at most ~52 bars fit on a phone, so the
 * year view averages each week — and averages over *logged* days only, or a
 * week where you tracked two days would look like a week of near-fasting.
 */
const buckets = computed(() => {
  if (!isYear.value) {
    return days.value.map((d) => ({
      key: d.date,
      label: fromLocalDate(d.date).toLocaleDateString(undefined, { weekday: 'narrow' }),
      kcal: d.kcal,
      tip: `${d.kcal} kcal`,
    }))
  }

  const out: { key: string; label: string; kcal: number; tip: string }[] = []
  let lastMonth = -1
  for (let i = 0; i < days.value.length; i += 7) {
    const week = days.value.slice(i, i + 7)
    const first = week[0]!
    const loggedDays = week.filter((d) => d.kcal > 0)
    const avg = loggedDays.length
      ? Math.round(loggedDays.reduce((sum, d) => sum + d.kcal, 0) / loggedDays.length)
      : 0

    // Label only the first bucket of each month, so the axis reads as a year
    // instead of 52 unreadable stubs.
    const started = fromLocalDate(first.date)
    const month = started.getMonth()
    const label =
      month === lastMonth
        ? ''
        : started.toLocaleDateString(undefined, { month: 'narrow' })
    lastMonth = month

    out.push({
      key: first.date,
      label,
      kcal: avg,
      tip: avg
        ? `${avg} kcal/day avg · week of ${first.date}`
        : `nothing logged · week of ${first.date}`,
    })
  }
  return out
})

const goal = computed(() => data.value?.goals?.calorie_goal ?? 2000)
const maxKcal = computed(() =>
  Math.max(goal.value, ...buckets.value.map((b) => b.kcal)) * 1.1,
)

const logged = computed(() => days.value.filter((d) => d.kcal > 0))
const avgKcal = computed(() =>
  logged.value.length
    ? Math.round(logged.value.reduce((s, d) => s + d.kcal, 0) / logged.value.length)
    : 0,
)
const totalBurned = computed(() => days.value.reduce((s, d) => s + d.burned, 0))

// --- Weight ---------------------------------------------------------------

const weights = computed(() => data.value?.weights ?? [])
const latestWeight = computed(() => weights.value[weights.value.length - 1] ?? null)

const weightChange = computed(() => {
  const w = weights.value
  if (w.length < 2) return null
  return w[w.length - 1]!.weight_kg - w[0]!.weight_kg
})

/** Change shown in the user's unit — a kg delta labelled "lb" would be a lie. */
const weightChangeDisplay = computed(() => {
  const delta = weightChange.value
  if (delta === null) return null
  return (unit.value === 'lb' ? kgToLb(delta) : delta).toFixed(1)
})

const goalWeight = computed(() => data.value?.goals?.goal_weight_kg ?? null)

/**
 * The weight line, in a 300×100 user-space box.
 *
 * `preserveAspectRatio="none"` lets the box stretch to whatever width the card
 * is; `vector-effect="non-scaling-stroke"` keeps the line from being stretched
 * with it. Dots are deliberately absent — at a year's worth of daily weigh-ins
 * they'd merge into a smear, and they'd render as ellipses under the stretch.
 */
const CHART_W = 300
const CHART_H = 100

const weightChart = computed(() => {
  const points = weights.value
  if (!from.value || points.length < 2) return null

  const span = Math.max(range.value - 1, 1)
  const dayIndex = (date: string) =>
    Math.round(
      (fromLocalDate(date).getTime() - fromLocalDate(from.value!).getTime()) / 86_400_000,
    )

  const values = points.map((p) => p.weight_kg)
  const withGoal = goalWeight.value === null ? values : [...values, goalWeight.value]
  const lo = Math.min(...withGoal)
  const hi = Math.max(...withGoal)
  // A flat week would otherwise divide by zero and draw at the very top.
  const pad = Math.max((hi - lo) * 0.15, 0.4)
  const min = lo - pad
  const max = hi + pad

  const x = (date: string) => (dayIndex(date) / span) * CHART_W
  const y = (kg: number) => CHART_H - ((kg - min) / (max - min)) * CHART_H

  return {
    line: points.map((p) => `${x(p.date).toFixed(2)},${y(p.weight_kg).toFixed(2)}`).join(' '),
    goalY: goalWeight.value === null ? null : y(goalWeight.value),
    min,
    max,
  }
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-2">
      <h1 class="font-semibold text-lg flex-1">Trends</h1>
      <div role="tablist" class="tabs tabs-box tabs-xs">
        <button
          v-for="r in RANGES" :key="r.days"
          role="tab" class="tab" :class="{ 'tab-active': range === r.days }"
          @click="range = r.days"
        >{{ r.label }}</button>
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
      <div v-if="weightChangeDisplay !== null" class="stat p-3">
        <div class="stat-title text-xs">Weight</div>
        <div class="stat-value text-xl tabular">
          {{ Number(weightChangeDisplay) > 0 ? '+' : '' }}{{ weightChangeDisplay }}
        </div>
        <div class="stat-desc text-xs">{{ unit }} over range</div>
      </div>
    </div>

    <!--
      Weight and calories share a wrapper purely so their order can swap: on
      the year view weight is the point of the screen. Ordering them in the
      page's own flex column would let `order-first` jump the heading too.
    -->
    <div class="flex flex-col gap-3">
    <section
      v-if="weightChart"
      class="card bg-base-100 shadow-sm"
      :class="isYear ? 'order-first' : 'order-last'"
    >
      <div class="card-body p-4 gap-2">
        <header class="flex items-baseline justify-between">
          <h2 class="font-semibold text-sm">Weight</h2>
          <span v-if="latestWeight" class="text-sm tabular">
            {{ formatWeight(latestWeight.weight_kg, unit) }}
          </span>
        </header>

        <div class="relative">
          <svg
            class="w-full h-32 overflow-visible"
            :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`Weight from ${formatWeight(weightChart.min, unit)} to ${formatWeight(weightChart.max, unit)}`"
          >
            <line
              v-if="weightChart.goalY !== null"
              x1="0" :y1="weightChart.goalY" :x2="CHART_W" :y2="weightChart.goalY"
              class="stroke-success/60" stroke-width="1"
              stroke-dasharray="4 3" vector-effect="non-scaling-stroke"
            />
            <polyline
              :points="weightChart.line"
              fill="none" class="stroke-secondary" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round"
              vector-effect="non-scaling-stroke"
            />
          </svg>

          <span class="absolute top-0 left-0 text-[0.6rem] text-base-content/40 tabular">
            {{ formatWeight(weightChart.max, unit) }}
          </span>
          <span class="absolute bottom-0 left-0 text-[0.6rem] text-base-content/40 tabular">
            {{ formatWeight(weightChart.min, unit) }}
          </span>
          <span
            v-if="goalWeight !== null"
            class="absolute right-0 text-[0.6rem] text-success/80 tabular -translate-y-1/2"
            :style="`top:${(weightChart.goalY! / CHART_H) * 100}%`"
          >goal</span>
        </div>

        <div class="flex justify-between text-[0.6rem] text-base-content/40">
          <span>{{ from }}</span>
          <span>{{ to }}</span>
        </div>
      </div>
    </section>

    <!-- Calories ----------------------------------------------------------->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold text-sm">
          Calories
          <span v-if="isYear" class="font-normal text-xs text-base-content/50">
            · weekly average
          </span>
        </h2>

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

          <div class="flex items-end gap-px h-full" :class="{ 'gap-1': !isYear }">
            <div
              v-for="b in buckets"
              :key="b.key"
              class="flex-1 flex flex-col justify-end h-full group relative"
            >
              <div
                class="rounded-t transition-all"
                :class="b.kcal > goal ? 'bg-error/70' : 'bg-primary/70'"
                :style="`height:${Math.max(b.kcal > 0 ? 2 : 0, (b.kcal / maxKcal) * 100)}%`"
              />
              <div class="absolute -top-5 left-1/2 -translate-x-1/2 hidden group-hover:block text-[0.6rem] tabular bg-neutral text-neutral-content px-1 rounded whitespace-nowrap z-20">
                {{ b.tip }}
              </div>
            </div>
          </div>
        </div>

        <!--
          A 52-bucket year gives each cell ~6px, which clips a letter in half.
          Only some buckets carry a label, so the labelled ones are positioned
          out of flow and allowed to overhang their neighbours.
        -->
        <div class="flex h-3" :class="isYear ? 'gap-px' : 'gap-1'">
          <div
            v-for="b in buckets" :key="b.key"
            class="flex-1 relative text-[0.6rem] text-base-content/40"
          >
            <span
              v-if="b.label"
              class="absolute top-0 whitespace-nowrap"
              :class="isYear ? 'left-0' : 'left-1/2 -translate-x-1/2'"
            >{{ b.label }}</span>
          </div>
        </div>
      </div>
    </section>
    </div>

    <!-- The exact numbers, for ranges short enough to list. -->
    <section v-if="!isYear && weights.length > 1" class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-2">
        <h2 class="font-semibold text-sm">Weigh-ins</h2>
        <ul class="text-sm divide-y divide-base-200">
          <li v-for="w in weights.slice().reverse()" :key="w.date" class="flex justify-between py-1.5">
            <span class="text-base-content/60">{{ w.date }}</span>
            <span class="tabular">{{ formatWeight(w.weight_kg, unit) }}</span>
          </li>
        </ul>
      </div>
    </section>

    <p v-if="!logged.length && !weights.length" class="text-center text-sm text-base-content/50 py-8">
      Log some food to see trends here.
    </p>
  </div>
</template>

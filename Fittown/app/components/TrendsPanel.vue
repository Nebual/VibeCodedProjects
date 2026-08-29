<script setup lang="ts">
import type { Goals } from '~/composables/useDiary'
import { formatWeight, kgToLb } from '#shared/body'
import { sharePermissions, type SharePermissions } from '#shared/sharing'
import { addDays, fromLocalDate } from '~/utils/dates'

/**
 * The trends screen's charts, pointed at whichever summary endpoint you give
 * it: your own (`/api/summary`) or a friend's (`/api/friends/3/summary`).
 *
 * One component rather than two screens that happen to draw the same shapes —
 * the calorie bucketing, the "average over logged days only" rule and the
 * unit conversion are all easy to get subtly different, and a friend's chart
 * that means something slightly different to your own is worse than no chart.
 *
 * A friend's response carries `permissions`; sections they don't share simply
 * aren't drawn. Your own response has none, which reads as "all of it".
 */
const props = defineProps<{
  /** Summary endpoint. Must accept `from` and `to` query parameters. */
  source: string
  /** Whose numbers these are, for the empty state. Omit for your own. */
  who?: string | null
}>()

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
  biometrics: {
    id: number
    name: string
    unit: string
    points: { date: string; value: number }[]
  }[]
  goals: Goals
  /** Only present when reading a friend's. */
  permissions?: SharePermissions
}

const { data } = await useFetch<Summary>(() => props.source, {
  query: { from, to },
  watch: [from, to],
  immediate: !!today.value,
  server: !!today.value,
})

/** Absent permissions mean it's your own data — you can see all of it. */
const allowed = computed(() =>
  data.value?.permissions
    ? data.value.permissions
    : sharePermissions(null),
)

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
 *
 * Each bucket carries three numbers: gross intake, burned, and net
 * (intake − burned). Net is what the bar's height shows — training counts —
 * while burned rides along as the overlaid green band.
 */
const buckets = computed(() => {
  if (!isYear.value) {
    return days.value.map((d) => ({
      key: d.date,
      label: fromLocalDate(d.date).toLocaleDateString(undefined, { weekday: 'narrow' }),
      kcal: d.kcal,
      burned: d.burned,
      net: d.kcal - d.burned,
      tip: d.burned
        ? `ate ${d.kcal} · burned ${d.burned} · net ${d.kcal - d.burned} kcal`
        : `${d.kcal} kcal`,
    }))
  }

  const out: {
    key: string; label: string; kcal: number; burned: number; net: number; tip: string
  }[] = []
  let lastMonth = -1
  for (let i = 0; i < days.value.length; i += 7) {
    const week = days.value.slice(i, i + 7)
    const first = week[0]!
    const loggedDays = week.filter((d) => d.kcal > 0)
    const avg = (pick: (d: typeof first) => number) =>
      loggedDays.length
        ? Math.round(loggedDays.reduce((sum, d) => sum + pick(d), 0) / loggedDays.length)
        : 0
    const kcal = avg((d) => d.kcal)
    const burned = avg((d) => d.burned)

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
      kcal,
      burned,
      net: kcal - burned,
      tip: kcal
        ? `${kcal} kcal/day ate · ${burned} burned · net ${kcal - burned} · week of ${first.date}`
        : `nothing logged · week of ${first.date}`,
    })
  }
  return out
})

const goal = computed(() => data.value?.goals?.calorie_goal ?? 2000)
// The scale has to fit both series: the net bars and the burned overlay.
const maxKcal = computed(() =>
  Math.max(goal.value, ...buckets.value.flatMap((b) => [b.net, b.kcal])) * 1.1,
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
 * Weights converted into whatever unit the user reads, because the chart
 * draws exactly the numbers it's given. Everything is stored in kg.
 */
const weightPoints = computed(() =>
  weights.value.map((w) => ({
    date: w.date,
    value: unit.value === 'lb' ? kgToLb(w.weight_kg) : w.weight_kg,
  })),
)

const goalWeightDisplay = computed(() => {
  const goal = goalWeight.value
  if (goal === null) return null
  return unit.value === 'lb' ? kgToLb(goal) : goal
})

/**
 * A rate (kg or lb per week), not an absolute weight, so `kgToLb` — a plain
 * multiplier with no offset — converts it just as validly as a point value.
 */
const goalRateDisplay = computed(() => {
  const rate = data.value?.goals?.goal_rate_kg_per_week ?? null
  if (rate === null) return null
  return unit.value === 'lb' ? kgToLb(rate) : rate
})

// --- Custom measurements ---------------------------------------------------

/**
 * Bicep, waist, resting heart rate — whatever the user chose to track, each
 * on its own chart. Series with a single reading are dropped: one point is a
 * number, not a trend, and MetricChart won't draw a line from it anyway.
 *
 * Values are stored in the unit the measurement was defined with, so unlike
 * weight they need no conversion.
 */
const biometricSeries = computed(() =>
  (data.value?.biometrics ?? []).filter((series) => series.points.length > 1),
)

const nothingToShow = computed(
  () =>
    !logged.value.length
    && !weights.value.length
    && !biometricSeries.value.length
    && !totalBurned.value,
)
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-2">
      <div class="flex-1 min-w-0">
        <slot name="title" />
      </div>
      <div role="tablist" class="tabs tabs-box tabs-xs">
        <button
          v-for="r in RANGES" :key="r.days"
          role="tab" class="tab" :class="{ 'tab-active': range === r.days }"
          @click="range = r.days"
        >{{ r.label }}</button>
      </div>
    </div>

    <div
      v-if="allowed.share_calories || allowed.share_exercise || allowed.share_weight"
      class="stats stats-horizontal bg-base-100 shadow-sm w-full"
    >
      <div v-if="allowed.share_calories" class="stat p-3">
        <div class="stat-title text-xs">Avg intake</div>
        <div class="stat-value text-xl tabular">{{ avgKcal }}</div>
        <div class="stat-desc text-xs">kcal · {{ logged.length }} days logged</div>
      </div>
      <div v-if="allowed.share_exercise" class="stat p-3">
        <div class="stat-title text-xs">Burned</div>
        <div class="stat-value text-xl tabular text-success">{{ totalBurned }}</div>
        <div class="stat-desc text-xs">kcal from training</div>
      </div>
      <div v-if="allowed.share_weight && weightChangeDisplay !== null" class="stat p-3">
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
      <MetricChart
        v-if="from && to && allowed.share_weight"
        label="Weight"
        :points="weightPoints"
        :unit="unit"
        :from="from"
        :to="to"
        :range-days="range"
        :goal="goalWeightDisplay"
        :goal-rate-per-week="goalRateDisplay"
        dots
        :class="isYear ? 'order-first' : 'order-last'"
      />

      <!-- Calories --------------------------------------------------------->
      <section v-if="allowed.share_calories" class="card bg-base-100 shadow-sm">
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
              <!--
                The bar is *net* (intake − burned), so a trained day reads
                honestly against the goal. The burned part is drawn back on in
                green from the bottom of the bar: the full column height is the
                gross intake, the solid top is what actually stayed in.
              -->
              <div class="relative w-full" :style="`height:${Math.max(b.kcal > 0 ? 2 : 0, (b.net / maxKcal) * 100)}%`">
                <div
                  v-if="b.burned > 0"
                  class="absolute bottom-0 inset-x-0 rounded-t bg-success/70"
                  :style="`height:${Math.min(100, (b.burned / Math.max(b.kcal, 1)) * 100)}%`"
                />
                <div
                  class="absolute inset-x-0 top-0 transition-all rounded-t"
                  :class="[b.net > goal ? 'bg-error/70' : 'bg-primary/70', { 'rounded-b-none': b.burned > 0 }]"
                  :style="`height:${Math.min(100, (b.net / Math.max(b.kcal, 1)) * 100)}%`"
                />
              </div>
              <div class="absolute -top-5 left-1/2 -translate-x-1/2 hidden group-hover:block text-[0.6rem] tabular bg-neutral text-neutral-content px-1 rounded whitespace-nowrap z-20">
                {{ b.tip }}
              </div>
            </div>
            </div>
          </div>

          <div class="flex items-center gap-3 text-[0.65rem] text-base-content/50">
            <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-sm bg-primary/70" /> net (ate − burned)</span>
            <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-sm bg-success/70" /> burned</span>
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
    <section
      v-if="allowed.share_weight && !isYear && weights.length > 1"
      class="card bg-base-100 shadow-sm"
    >
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

    <!-- Whatever else the user tracks, one chart each. -->
    <template v-if="allowed.share_weight">
      <MetricChart
        v-for="series in biometricSeries"
        :key="series.id"
        :label="series.name"
        :points="series.points"
        :unit="series.unit"
        :from="from!"
        :to="to!"
        :range-days="range"
        stroke="stroke-accent"
      />
    </template>

    <p v-if="nothingToShow" class="text-center text-sm text-base-content/50 py-8">
      <template v-if="who">Nothing logged here in this range.</template>
      <template v-else>Log some food to see trends here.</template>
    </p>
  </div>
</template>

<script setup lang="ts">
import { fromLocalDate } from '~/utils/dates'

/**
 * A line chart of one measurement over the selected date range.
 *
 * Values arrive already in display units — weight converted to lb if that's
 * the preference, a bicep in whatever the measurement itself uses — so this
 * component never has to know which quantity it's drawing.
 *
 * Rendered in a 300×100 user-space box with `preserveAspectRatio="none"`, so
 * it stretches to the card width, plus `vector-effect="non-scaling-stroke"` to
 * stop the line stretching with it. Dots are deliberately absent: at a year of
 * daily weigh-ins they merge into a smear, and they'd render as ellipses under
 * the stretch anyway.
 */
const props = defineProps<{
  label: string
  /** Chronological, already converted to `unit`. */
  points: { date: string; value: number }[]
  unit: string
  /** First day of the range, for x positioning. */
  from: string
  to: string
  /** Days spanned, so a sparse series still sits correctly along the axis. */
  rangeDays: number
  /** Optional dashed target line, in the same unit as `points`. */
  goal?: number | null
  /** Colour class for the line, so stacked charts stay distinguishable. */
  stroke?: string
}>()

const CHART_W = 300
const CHART_H = 100

const latest = computed(() => props.points[props.points.length - 1] ?? null)

const chart = computed(() => {
  if (props.points.length < 2) return null

  const span = Math.max(props.rangeDays - 1, 1)
  const start = fromLocalDate(props.from).getTime()
  const dayIndex = (date: string) =>
    Math.round((fromLocalDate(date).getTime() - start) / 86_400_000)

  const values = props.points.map((p) => p.value)
  const withGoal =
    props.goal === null || props.goal === undefined ? values : [...values, props.goal]
  const lo = Math.min(...withGoal)
  const hi = Math.max(...withGoal)
  // A flat series would otherwise divide by zero and draw along the very top.
  const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.01, 0.4)
  const min = lo - pad
  const max = hi + pad

  const x = (date: string) => (dayIndex(date) / span) * CHART_W
  const y = (value: number) => CHART_H - ((value - min) / (max - min)) * CHART_H

  return {
    line: props.points.map((p) => `${x(p.date).toFixed(2)},${y(p.value).toFixed(2)}`).join(' '),
    goalY: props.goal === null || props.goal === undefined ? null : y(props.goal),
    min,
    max,
  }
})

/** Trim trailing zeroes so 38.0 cm reads as 38 cm. */
const show = (value: number) => `${Number(value.toFixed(1))} ${props.unit}`
</script>

<template>
  <section v-if="chart" class="card bg-base-100 shadow-sm">
    <div class="card-body p-4 gap-2">
      <header class="flex items-baseline justify-between">
        <h2 class="font-semibold text-sm">{{ label }}</h2>
        <span v-if="latest" class="text-sm tabular">{{ show(latest.value) }}</span>
      </header>

      <div class="relative">
        <svg
          class="w-full h-32 overflow-visible"
          :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
          preserveAspectRatio="none"
          role="img"
          :aria-label="`${label} from ${show(chart.min)} to ${show(chart.max)}`"
        >
          <line
            v-if="chart.goalY !== null"
            x1="0" :y1="chart.goalY" :x2="CHART_W" :y2="chart.goalY"
            class="stroke-success/60" stroke-width="1"
            stroke-dasharray="4 3" vector-effect="non-scaling-stroke"
          />
          <polyline
            :points="chart.line"
            fill="none" :class="stroke ?? 'stroke-secondary'" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>

        <span class="absolute top-0 left-0 text-[0.6rem] text-base-content/40 tabular">
          {{ show(chart.max) }}
        </span>
        <span class="absolute bottom-0 left-0 text-[0.6rem] text-base-content/40 tabular">
          {{ show(chart.min) }}
        </span>
        <span
          v-if="chart.goalY !== null"
          class="absolute right-0 text-[0.6rem] text-success/80 tabular -translate-y-1/2"
          :style="`top:${(chart.goalY / CHART_H) * 100}%`"
        >goal</span>
      </div>

      <div class="flex justify-between text-[0.6rem] text-base-content/40">
        <span>{{ from }}</span>
        <span>{{ to }}</span>
      </div>
    </div>
  </section>
</template>

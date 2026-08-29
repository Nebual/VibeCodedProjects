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
 * stop the line stretching with it. The line itself carries no SVG dots — an
 * `<ellipse>` is what a circle becomes once the non-uniform stretch gets it —
 * so `dots` instead overlays plain HTML buttons, positioned by percentage,
 * for a hoverable/focusable marker at each point. Skipped past a point count
 * where they'd just merge into a smear (a year of daily weigh-ins).
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
  /**
   * Expected rate of change toward `goal`, same unit as `points`, per week.
   * Sizes the y-axis instead of `goal` itself — a goal weight far off in the
   * future would otherwise force the axis to span the whole journey, crushing
   * a short window's real ups and downs into a near-flat line.
   */
  goalRatePerWeek?: number | null
  /** Colour class for the line, so stacked charts stay distinguishable. */
  stroke?: string
  /** Show a hoverable marker at each point. Off by default: most series here
   *  are dense enough that markers would just clutter the line. */
  dots?: boolean
}>()

const CHART_W = 300
const CHART_H = 100

/** Past this many points, markers would overlap into a smear rather than
 *  read as individual weigh-ins. */
const MAX_DOTS = 120

const latest = computed(() => props.points[props.points.length - 1] ?? null)

const chart = computed(() => {
  if (props.points.length < 2) return null

  const span = Math.max(props.rangeDays - 1, 1)
  const start = fromLocalDate(props.from).getTime()
  const dayIndex = (date: string) =>
    Math.round((fromLocalDate(date).getTime() - start) / 86_400_000)

  const values = props.points.map((p) => p.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const actualRange = hi - lo
  // A flat series would otherwise divide by zero and draw along the very top.
  const basePad = Math.max(actualRange * 0.15, Math.abs(hi) * 0.01, 0.4)

  /**
   * The axis spans whichever needs more room: the change the goal rate
   * implies over this window plus a week's cushion, or the actual swing in
   * the data padded as usual. The real swing always wins when it's bigger,
   * so a real change is never clipped to fit a tighter, rate-driven scale.
   */
  const rate = props.goalRatePerWeek ? Math.abs(props.goalRatePerWeek) : 0
  const targetSpan = rate ? rate * (props.rangeDays / 7) + rate : 0
  const actualSpanPadded = actualRange + basePad * 2
  const finalSpan = Math.max(actualSpanPadded, targetSpan)
  const extraPad = Math.max(0, (finalSpan - actualRange) / 2)

  const min = lo - extraPad
  const max = hi + extraPad

  const x = (date: string) => (dayIndex(date) / span) * CHART_W
  const y = (value: number) => CHART_H - ((value - min) / (max - min)) * CHART_H

  const goalY = props.goal === null || props.goal === undefined ? null : y(props.goal)
  const goalOnChart = goalY !== null && goalY >= 0 && goalY <= CHART_H

  // Percentage positions so markers can be plain HTML overlaid on the SVG,
  // rather than `<circle>`s that `preserveAspectRatio="none"` would stretch
  // into ellipses.
  const dots =
    props.dots && props.points.length <= MAX_DOTS
      ? props.points.map((p) => ({
          date: p.date,
          value: p.value,
          leftPct: (x(p.date) / CHART_W) * 100,
          topPct: (y(p.value) / CHART_H) * 100,
        }))
      : []

  return {
    line: props.points.map((p) => `${x(p.date).toFixed(2)},${y(p.value).toFixed(2)}`).join(' '),
    goalY: goalOnChart ? goalY : null,
    /** Set when there's a goal but the tightened axis leaves no room to draw
     *  its line — shown as plain text next to the latest reading instead. */
    goalOffChart: props.goal != null && !goalOnChart ? props.goal : null,
    dots,
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
        <span class="flex items-baseline gap-2">
          <span v-if="chart.goalOffChart != null" class="text-xs text-base-content/40 tabular">
            goal {{ show(chart.goalOffChart) }}
          </span>
          <span v-if="latest" class="text-sm tabular">{{ show(latest.value) }}</span>
        </span>
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

        <button
          v-for="d in chart.dots"
          :key="d.date"
          type="button"
          class="group absolute w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-secondary ring-2 ring-base-100 focus:outline-none focus-visible:ring-primary"
          :style="`left:${d.leftPct}%; top:${d.topPct}%`"
          :aria-label="`${show(d.value)} on ${d.date}`"
        >
          <span
            class="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block group-focus:block text-[0.65rem] tabular bg-neutral text-neutral-content px-1.5 py-0.5 rounded whitespace-nowrap z-20"
          >{{ show(d.value) }} · {{ d.date }}</span>
        </button>
      </div>

      <div class="flex justify-between text-[0.6rem] text-base-content/40">
        <span>{{ from }}</span>
        <span>{{ to }}</span>
      </div>
    </div>
  </section>
</template>

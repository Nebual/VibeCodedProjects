<script setup lang="ts">
import { HEADLINE_MACROS, NUTRIENTS, type NutrientTotals } from '#shared/nutrients'
import type { Goals } from '~/composables/useDiary'

const props = defineProps<{
  totals: NutrientTotals
  goals?: Goals
}>()

const GROUP_LABELS: Record<string, string> = {
  macro: 'Macronutrients',
  vitamin: 'Vitamins',
  mineral: 'Minerals',
  other: 'Other',
}

/**
 * The user's own goals override the generic reference values for the handful
 * of nutrients they can actually configure.
 */
function targetFor(key: string, fallback?: number) {
  const goals = props.goals
  if (!goals) return fallback
  const overrides: Record<string, number> = {
    protein_g: goals.protein_g,
    carbs_g: goals.carbs_g,
    fat_g: goals.fat_g,
    fiber_g: goals.fiber_g,
  }
  return overrides[key] ?? fallback
}

const groups = computed(() =>
  Object.entries(GROUP_LABELS).map(([group, label]) => {
    // The three headline macros lead the macro group in display order — Fat,
    // Carbs, Protein — with the rest following in catalogue order. Every other
    // group is displayed as-is.
    const rows = NUTRIENTS.filter((n) => n.group === group && n.key !== 'kcal')
      .sort((a, b) => {
        if (group !== 'macro') return 0
        const ai = HEADLINE_MACROS.indexOf(a.key as never)
        const bi = HEADLINE_MACROS.indexOf(b.key as never)
        if (ai === -1 && bi === -1) return 0
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      })
      // Rows whose value is unknown ("not recorded") are dropped entirely rather
      // than rendered as a dash — a vitamin we don't know about is not a vitamin
      // they haven't got, and a wall of "not recorded" tells a long story about
      // nothing. A group that ends up with no rows is hidden by `visibleGroups`.
      .map((n) => {
        const raw = props.totals[n.key]
        const known = typeof raw === 'number' && Number.isFinite(raw)
        const value = known ? raw : null
        if (!known) return null
        const target = targetFor(n.key, n.rda)
        const pct = target ? Math.round((value / target) * 100) : null
        return { ...n, value, target, pct }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
    return { label, rows }
  }),
)

/** Hide groups where nothing at all is known, rather than a wall of dashes. */
const visibleGroups = computed(() =>
  groups.value.filter((g) => g.rows.some((r) => r.value !== null)),
)

/** Under-target is neutral; over a *limit* is a warning, over a target is good. */
function barClass(limit: boolean | undefined, pct: number | null) {
  if (pct === null) return 'bg-base-content/20'
  if (limit) return pct > 100 ? 'bg-error' : 'bg-base-content/30'
  if (pct >= 100) return 'bg-success'
  if (pct >= 50) return 'bg-primary'
  return 'bg-primary/50'
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div v-for="group in visibleGroups" :key="group.label">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-base-content/50 mb-2">
        {{ group.label }}
      </h3>

      <ul class="flex flex-col gap-1.5">
        <li
          v-for="row in group.rows"
          :key="row.key"
          class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 items-center text-sm"
        >
          <span class="truncate">
            {{ row.label }}
            <span v-if="row.limit" class="text-[0.65rem] text-base-content/40">limit</span>
          </span>

          <span class="tabular text-right text-base-content/70">
            {{ row.value.toFixed(row.decimals) }}<span class="text-base-content/40"> {{ row.unit }}</span>
            <span v-if="row.pct !== null" class="ml-2 inline-block w-11 text-right">
              {{ row.pct }}%
            </span>
          </span>

          <div class="col-span-2 h-1 rounded-full bg-base-300 overflow-hidden">
            <div
              class="h-full rounded-full transition-all"
              :class="barClass(row.limit, row.pct)"
              :style="`width:${Math.min(100, row.pct ?? 0)}%`"
            />
          </div>
        </li>
      </ul>
    </div>

    <p v-if="!visibleGroups.length" class="text-sm text-base-content/50">
      No detailed nutrition recorded for this food.
    </p>
  </div>
</template>

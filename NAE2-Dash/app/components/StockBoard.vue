<script setup lang="ts">
import type { SortMode } from '~/utils/essentia'

const props = defineProps<{ kind: 'essentia' | 'items' }>()

const { snapshot, saveTarget, resetTargets } = useEssentiaStock()

const sortMode = ref<SortMode>('amount')
const query = ref('')
// Only show entries that have a minimum target set (items tab mainly).
const onlyWithMinimum = ref(false)

const isEssentia = computed(() => props.kind === 'essentia')

const reported = computed(() =>
  Object.entries(isEssentia.value ? snapshot.value.essentia : snapshot.value.items)
    .map(([name, amount]) => ({ name, amount })),
)

const stocked = computed(() => sortStock(reported.value, sortMode.value))

// Targets are sparse, shared between both tabs, and keyed by whatever casing the
// reporter used.
const minimums = computed(() => byLowerName(snapshot.value.minimums))
const maximums = computed(() => byLowerName(snapshot.value.maximums))

const visible = computed(() => {
  let list = stocked.value
  if (onlyWithMinimum.value) {
    list = list.filter(entry => minimums.value[entry.name.toLowerCase()] !== undefined)
  }
  const needle = query.value.trim().toLowerCase()
  if (!needle) return list
  return list.filter(entry => entry.name.toLowerCase().includes(needle))
})

const total = computed(() => stocked.value.reduce((sum, e) => sum + e.amount, 0))

// A depleted entry still has a tile, but it no longer occupies a storage type.
const typeCount = computed(() => stocked.value.filter(entry => entry.amount > 0).length)

/** Warn as storage approaches its cap, and flag anything already over it. */
function capacityClass(current: number, max: number): string {
  if (!max) return ''
  if (current > max) return 'text-error'
  if (current >= max * 0.9) return 'text-warning'
  return ''
}

// Flash a tile for a moment whenever its amount moves, so a live POST is visible.
const trends = ref(new Map<string, 'up' | 'down'>())
const seen = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

watch(stocked, (list) => {
  for (const entry of list) {
    const previous = seen.get(entry.name)
    seen.set(entry.name, entry.amount)
    if (previous === undefined || previous === entry.amount) continue

    trends.value.set(entry.name, entry.amount > previous ? 'up' : 'down')
    clearTimeout(timers.get(entry.name))
    timers.set(
      entry.name,
      setTimeout(() => {
        trends.value.delete(entry.name)
        timers.delete(entry.name)
      }, 1500),
    )
  }
}, { immediate: true })

onBeforeUnmount(() => {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
})

const updatedAt = computed(() =>
  snapshot.value.updatedAt
    ? new Date(snapshot.value.updatedAt).toLocaleTimeString('en-US')
    : null,
)

const samplePayload = computed(() =>
  isEssentia.value ? '{"essentia":{"Ignis":720}}' : '{"items":{"Iron Dust":40}}',
)
</script>

<template>
  <div class="min-h-screen bg-base-100 text-base-content">
    <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header class="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Nebtown's AE2 Stock Manager</h1>
          <p class="mt-1 text-sm text-base-content/60">
            <template v-if="updatedAt">Last update {{ updatedAt }}</template>
            <template v-else>Awaiting first report</template>
          </p>
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            class="btn btn-sm btn-square border-base-content/25"
            :class="snapshot.acceptingTargets ? 'btn-warning' : ''"
            :title="snapshot.acceptingTargets
              ? 'Waiting for the next report to supply minimums and maximums'
              : 'Let the next report overwrite the stored minimums and maximums'"
            :aria-label="'Accept minimums and maximums from the next report'"
            :aria-pressed="snapshot.acceptingTargets"
            @click="resetTargets()"
          >
            <svg
              class="size-4"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-3.4-7.05" />
              <path d="M21 3v5.5h-5.5" />
            </svg>
          </button>

          <div class="stats stats-horizontal border border-base-300 bg-base-200 shadow-sm">
            <div class="stat px-4 py-2">
              <div class="stat-title text-xs">Types</div>
              <div class="stat-value text-xl tabular-nums">
                <span :class="isEssentia ? capacityClass(typeCount, snapshot.maxEssentiaTypes) : ''">
                  {{ typeCount }}
                </span>
                <span v-if="isEssentia" class="text-base font-normal text-base-content/40">
                  / {{ snapshot.maxEssentiaTypes }}
                </span>
              </div>
            </div>
            <div class="stat px-4 py-2">
              <div class="stat-title text-xs">Total</div>
              <div class="stat-value text-xl tabular-nums">
                <span :class="isEssentia ? capacityClass(total, snapshot.maxEssentiaAmount) : ''">
                  {{ formatAmount(total) }}
                </span>
                <span v-if="isEssentia" class="text-base font-normal text-base-content/40">
                  / {{ formatAmount(snapshot.maxEssentiaAmount) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div role="tablist" class="tabs tabs-box mb-4 w-fit">
        <NuxtLink to="/" role="tab" class="tab" :class="isEssentia ? 'tab-active' : ''">
          Essentia
        </NuxtLink>
        <NuxtLink to="/items" role="tab" class="tab" :class="!isEssentia ? 'tab-active' : ''">
          Items
        </NuxtLink>
      </div>

      <div class="mb-4 flex flex-wrap items-center gap-2">
        <label class="input input-sm w-full max-w-xs focus-within:outline-none!">
          <svg
            class="size-4 opacity-50"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            v-model="query"
            type="search"
            :placeholder="isEssentia ? 'Search essentia…' : 'Search items…'"
            :aria-label="`Search ${kind} by name`"
          >
        </label>

        <button
          type="button"
          class="btn btn-sm border-base-content/25 gap-2"
          :aria-label="`Sort by ${sortMode === 'amount' ? 'amount' : 'name'}, click to change`"
          @click="sortMode = sortMode === 'amount' ? 'name' : 'amount'"
        >
          <svg
            class="size-4"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M6 4v16m0 0-3-3m3 3 3-3" />
            <path d="M12 6h9M12 12h6M12 18h3" />
          </svg>
          <span class="text-base-content/50">
            {{ sortMode === 'amount' ? 'Amount' : 'Name' }}
          </span>
        </button>

        <button
          type="button"
          class="btn btn-sm border-base-content/25 gap-2"
          :class="onlyWithMinimum ? 'btn-primary' : ''"
          :aria-label="onlyWithMinimum
            ? 'Showing only stocks that have a minimum target set; click to show all'
            : 'Filter to stocks that have a minimum target set'"
          :aria-pressed="onlyWithMinimum"
          title="Show only stocks with a minimum target"
          @click="onlyWithMinimum = !onlyWithMinimum"
        >
          <svg
            class="size-4"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 5h18M6 12h12M10 19h4" />
          </svg>
          <span class="text-base-content/50">Min set</span>
        </button>

        <span v-if="query.trim()" class="text-sm text-base-content/50">
          {{ visible.length }} of {{ stocked.length }}
        </span>
      </div>

      <div
        v-if="visible.length"
        class="grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-2.5"
      >
        <StockTile
          v-for="entry in visible"
          :key="entry.name"
          :name="entry.name"
          :amount="entry.amount"
          :icon="isEssentia ? essentiaIcon(entry.name) : undefined"
          :trend="trends.get(entry.name)"
          :minimum="minimums[entry.name.toLowerCase()]"
          :maximum="maximums[entry.name.toLowerCase()]"
          :min-title="isEssentia ? undefined : 'Minimum target'"
          :hide-maximum="!isEssentia"
          @save-target="(kind, value) => saveTarget(entry.name, kind, value)"
        />
      </div>

      <div
        v-else-if="stocked.length"
        class="rounded-lg border border-dashed border-base-300 bg-base-200/50 p-8 text-center text-base-content/60"
      >
        Nothing matching
        <template v-if="onlyWithMinimum">a set minimum target</template>
        <template v-else>“{{ query.trim() }}”</template>.
      </div>

      <div v-else class="rounded-lg border border-dashed border-base-300 bg-base-200/50 p-8">
        <h2 class="text-lg font-semibold">No {{ kind }} reported yet</h2>
        <p class="mt-1 text-sm text-base-content/60">
          POST a snapshot to <code class="rounded bg-base-300 px-1.5 py-0.5">/api/mc-update</code>
          and this grid fills in without a reload.
        </p>
        <pre class="mt-4 overflow-x-auto rounded-lg bg-base-300 p-4 text-xs"><code>curl -X POST http://localhost:3000/api/mc-update \
  -H 'Content-Type: application/json' \
  -d '{{ samplePayload }}'</code></pre>
      </div>
    </div>
  </div>
</template>

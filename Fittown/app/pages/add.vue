<script setup lang="ts">
import type { FoodRow } from '~/composables/useDiary'
import { MEAL_LABELS, type MealName } from '~/composables/useDiary'

const route = useRoute()
const meal = computed(() => (route.query.meal as MealName) || 'snack')
const today = useToday()

const date = computed(() => (route.query.d as string) || today.value)

useHead({ title: () => `Add to ${MEAL_LABELS[meal.value] ?? 'diary'} · Fittown` })

const query = ref('')
const debounced = ref('')
const tab = ref<'search' | 'recent'>('recent')

// Debounce so a fast typist doesn't fire a query per keystroke.
let timer: ReturnType<typeof setTimeout> | undefined
watch(query, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    debounced.value = value.trim()
    if (debounced.value.length >= 2) tab.value = 'search'
  }, 220)
})
onBeforeUnmount(() => clearTimeout(timer))

const { data: searchData, pending: searching } = await useFetch<{ results: FoodRow[] }>(
  '/api/foods/search',
  { query: { q: debounced }, watch: [debounced], immediate: false, default: () => ({ results: [] }) },
)

const { data: recentData } = await useFetch<{ results: FoodRow[] }>('/api/foods/recent', {
  query: { meal },
  default: () => ({ results: [] }),
})

const results = computed(() =>
  tab.value === 'search' ? (searchData.value?.results ?? []) : (recentData.value?.results ?? []),
)

const showScanner = ref(false)
</script>

<template>
  <div class="flex flex-col gap-3">
    <header class="flex items-center gap-2">
      <button class="btn btn-ghost btn-sm btn-square" aria-label="Back" @click="$router.back()">
        <AppIcon name="chevronLeft" class="w-5 h-5" />
      </button>
      <h1 class="font-semibold flex-1">Add to {{ MEAL_LABELS[meal] }}</h1>
    </header>

    <div class="flex gap-2">
      <label class="input input-bordered flex items-center gap-2 flex-1">
        <AppIcon name="search" class="w-4 h-4 opacity-50 shrink-0" />
        <input
          v-model="query"
          type="search"
          class="grow min-w-0"
          placeholder="Search foods…"
          autocomplete="off"
        >
        <span v-if="searching" class="loading loading-spinner loading-xs" />
      </label>

      <button
        class="btn btn-outline btn-square"
        aria-label="Scan barcode"
        @click="showScanner = true"
      >
        <AppIcon name="barcode" class="w-5 h-5" />
      </button>
    </div>

    <div role="tablist" class="tabs tabs-box">
      <button
        role="tab"
        class="tab flex-1"
        :class="{ 'tab-active': tab === 'recent' }"
        @click="tab = 'recent'"
      >
        Frequent
      </button>
      <button
        role="tab"
        class="tab flex-1"
        :class="{ 'tab-active': tab === 'search' }"
        :disabled="debounced.length < 2"
        @click="tab = 'search'"
      >
        Search
      </button>
    </div>

    <div class="card bg-base-100 shadow-sm overflow-hidden">
      <FoodResultList v-if="results.length" :foods="results" :meal="meal" :date="date" />

      <p v-else-if="tab === 'search' && debounced.length >= 2 && !searching" class="p-6 text-center text-sm text-base-content/50">
        No matches for “{{ debounced }}”.
      </p>
      <p v-else-if="tab === 'recent'" class="p-6 text-center text-sm text-base-content/50">
        Foods you log will appear here for quick re-adding.
      </p>
      <p v-else class="p-6 text-center text-sm text-base-content/50">
        Type at least two letters to search 200,000+ foods.
      </p>
    </div>

    <NuxtLink
      :to="`/food/new?meal=${meal}${date ? `&d=${date}` : ''}`"
      class="btn btn-outline gap-2"
    >
      <AppIcon name="plus" class="w-4 h-4" />
      Create a custom food
    </NuxtLink>

    <BarcodeScanner
      v-if="showScanner"
      :meal="meal"
      :date="date"
      @close="showScanner = false"
    />
  </div>
</template>

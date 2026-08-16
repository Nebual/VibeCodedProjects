<script setup lang="ts">
import { ACTIVITY_CATEGORIES, type CategoryKey } from '#shared/activities'

/**
 * Choose an activity by browsing categories, or by typing past them.
 *
 * A flat alphabetical list of ninety activities is a wall of text on a phone,
 * and it buries the thing you do three times a week under things you have
 * never done. The grid gives eight taps' worth of structure; search stays
 * available for people who already know the name.
 */
export interface Exercise {
  id: number
  name: string
  category: string
  met: number | null
  met_light: number | null
  met_hard: number | null
  tracks_sets: number
  tracks_distance: number
  hint: string | null
  owner_user_id: number | null
  categories: string[]
}

const props = defineProps<{
  /** Most recently logged activities, newest first. Owned by the page so it
   *  can be refreshed after a workout is saved. */
  recent?: Exercise[]
}>()

const emit = defineEmits<{ select: [exercise: Exercise] }>()

const search = ref('')
const category = ref<CategoryKey | null>(null)

// Searching is a global action: it should look across everything, not just
// inside whichever category happens to be open.
watch(search, (value) => {
  if (value.trim()) category.value = null
})

const query = computed(() => ({
  q: search.value.trim() || undefined,
  category: search.value.trim() ? undefined : (category.value ?? undefined),
}))

const browsing = computed(() => !!search.value.trim() || !!category.value)

const { data } = await useFetch<{ results: Exercise[] }>('/api/exercises', {
  query,
  watch: [query],
  immediate: false,
  default: () => ({ results: [] }),
})

const results = computed(() => (browsing.value ? data.value?.results ?? [] : []))

const openCategory = computed(() =>
  ACTIVITY_CATEGORIES.find((c) => c.key === category.value) ?? null,
)

function back() {
  category.value = null
  search.value = ''
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <label class="input input-bordered flex items-center gap-2">
      <AppIcon name="search" class="w-4 h-4 opacity-50 shrink-0" />
      <input
        v-model="search" type="search" class="grow min-w-0"
        placeholder="Search activities…"
      >
    </label>

    <!--
      Recently used, above the grid. Training runs in phases, so the handful
      of things you're doing this month is almost always what you want, and
      browsing to them every time is three taps you shouldn't need.
    -->
    <div v-if="!browsing && props.recent?.length" class="flex flex-col gap-1.5">
      <span class="label-text text-xs text-base-content/60">Recent</span>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="ex in props.recent"
          :key="ex.id"
          class="btn btn-sm btn-outline normal-case font-normal"
          @click="emit('select', ex)"
        >{{ ex.name }}</button>
      </div>
    </div>

    <!-- Category grid -->
    <div v-if="!browsing" class="grid grid-cols-2 gap-2">
      <button
        v-for="c in ACTIVITY_CATEGORIES"
        :key="c.key"
        class="btn btn-outline h-auto py-3 flex-col gap-1 items-start text-left normal-case"
        @click="category = c.key"
      >
        <AppIcon :name="c.icon" class="w-6 h-6 text-primary" />
        <span class="font-semibold text-sm">{{ c.label }}</span>
        <span class="text-[0.65rem] font-normal opacity-60 leading-tight">
          {{ c.blurb }}
        </span>
      </button>
    </div>

    <!-- Results -->
    <template v-else>
      <div class="flex items-center gap-2">
        <button class="btn btn-ghost btn-xs btn-square" aria-label="Back" @click="back">
          <AppIcon name="chevronLeft" class="w-4 h-4" />
        </button>
        <span class="text-sm font-medium flex-1">
          {{ openCategory?.label ?? `“${search.trim()}”` }}
        </span>
        <span class="text-xs text-base-content/40">{{ results.length }}</span>
      </div>

      <ul class="max-h-80 overflow-y-auto divide-y divide-base-200 -mx-4">
        <li v-for="ex in results" :key="ex.id">
          <button
            class="w-full text-left px-4 py-2.5 hover:bg-base-200 flex items-center gap-2"
            @click="emit('select', ex)"
          >
            <span class="flex-1 text-sm">{{ ex.name }}</span>
            <span v-if="ex.owner_user_id" class="badge badge-ghost badge-sm">yours</span>
            <span
              v-else-if="ex.met_light !== null"
              class="text-[0.6rem] text-base-content/40 tabular"
            >{{ ex.met_light }}–{{ ex.met_hard }} MET</span>
            <span v-else class="text-[0.6rem] text-base-content/40 tabular">
              {{ ex.met }} MET
            </span>
          </button>
        </li>
      </ul>

      <p v-if="!results.length" class="text-sm text-base-content/50 py-2">
        Nothing here. Try a different search.
      </p>
    </template>
  </div>
</template>

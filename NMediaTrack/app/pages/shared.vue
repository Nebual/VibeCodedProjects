<script setup lang="ts">
import type { MediaItem } from '~~/shared/types'
import { SORT_DEFAULT_DIR, sortMedia } from '~/utils/sortMedia'
import type { SortDir, SortKey } from '~/utils/sortMedia'

const { sharedWithMe, pending, canEdit } = useMedia()
const { name } = useUser()
const { mode: viewMode, load: loadViewMode } = useViewMode()
onMounted(loadViewMode)

// One sort applies across every owner's section.
const sortKey = ref<SortKey>('recent')
const sortDir = ref<SortDir>(SORT_DEFAULT_DIR.recent)

function toggleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = SORT_DEFAULT_DIR[key]
  }
}

// Group the shared items by their owner so each person's list is its own section.
const byOwner = computed(() => {
  const groups = new Map<string, MediaItem[]>()
  for (const item of sharedWithMe.value) {
    const list = groups.get(item.owner) ?? []
    list.push(item)
    groups.set(item.owner, list)
  }
  return [...groups.entries()]
    .map(
      ([owner, list]) =>
        [
          owner,
          sortMedia(list, sortKey.value, sortDir.value, { viewer: name.value }),
        ] as const,
    )
    .sort((a, b) => a[0].localeCompare(b[0]))
})

// Editing a friend's entry opens the same modal the library uses.
const showModal = ref(false)
const editing = ref<MediaItem | null>(null)
function openEdit(item: MediaItem) {
  editing.value = item
  showModal.value = true
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold">Shared with you</h1>
      <p class="mt-1 text-sm opacity-70">
        Once someone tags you on any of their media, you can view their whole list here.
      </p>
    </div>

    <div v-if="pending && !sharedWithMe.length" class="flex justify-center py-20">
      <span class="loading loading-spinner loading-lg" />
    </div>

    <div
      v-else-if="!sharedWithMe.length"
      class="rounded-box border border-dashed border-base-300 py-20 text-center"
    >
      <div class="text-5xl">🤝</div>
      <h2 class="mt-4 text-xl font-semibold">Nothing shared yet</h2>
      <p class="mt-1 opacity-70">
        When a friend tags your name in any of their media, their whole list
        shows up here — handy for finding a game to play together.
      </p>
    </div>

    <div v-else class="space-y-10">
      <section v-for="[owner, list] in byOwner" :key="owner">
        <div class="mb-3 flex items-center gap-3">
          <div class="avatar avatar-placeholder">
            <div class="w-10 rounded-full bg-secondary text-secondary-content">
              <span class="text-lg">{{ owner.charAt(0).toUpperCase() }}</span>
            </div>
          </div>
          <div>
            <h2 class="text-xl font-semibold">{{ owner }}'s list</h2>
            <p class="text-xs opacity-60">
              {{ list.length }} shared item{{ list.length === 1 ? '' : 's' }}
            </p>
          </div>
        </div>
        <MediaTable
          v-if="viewMode === 'list'"
          :items="list"
          :sort-key="sortKey"
          :sort-dir="sortDir"
          @sort="toggleSort"
          @edit="openEdit"
        />
        <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MediaCard
            v-for="item in list"
            :key="item.id"
            :item="item"
            :editable="canEdit(item)"
            @edit="openEdit"
          />
        </div>
      </section>
    </div>

    <MediaFormModal
      v-if="showModal"
      :item="editing"
      @close="showModal = false"
    />
  </div>
</template>

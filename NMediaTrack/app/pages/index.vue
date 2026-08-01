<script setup lang="ts">
import { isSoloable, MEDIA_TYPES, TYPE_META } from '~~/shared/types'
import type { MediaItem, MediaType } from '~~/shared/types'

const { name } = useUser()
const { mine, taggedIn, canEdit, pending, refresh } = useMedia()

// --- Filters & sorting -------------------------------------------------------
const typeFilter = ref<MediaType | 'all'>('all')
const statusFilter = ref<'all' | 'backlog' | 'active' | 'paused' | 'completed' | 'dropped'>('all')
const search = ref('')
const sortBy = ref<'recent' | 'title' | 'stars'>('recent')

// Media others have tagged you in shows up here by default — it's still stuff
// you're actively consuming, even if you don't own the entry.
const showTagged = ref(true)

const base = computed(() =>
  showTagged.value ? [...mine.value, ...taggedIn.value] : mine.value,
)

// --- Friend filter -----------------------------------------------------------
const selectedFriends = ref<string[]>([])
// "Solo" is a mode, not a person — playing alone and playing with Bishop are
// different questions, so picking one clears the other.
const soloOnly = ref(false)

/** Everyone involved in the visible media, other than you. */
const friendOptions = computed(() => {
  const me = name.value.trim().toLowerCase()
  const seen = new Map<string, string>() // lowercase -> display
  for (const m of base.value) {
    for (const p of [m.owner, ...m.companions]) {
      const key = p.trim().toLowerCase()
      if (key && key !== me && !seen.has(key)) seen.set(key, p.trim())
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
})

/** How many of the selected friends are on this item (owner counts too). */
function friendMatches(item: MediaItem): number {
  if (!selectedFriends.value.length) return 0
  const involved = new Set(
    [item.owner, ...item.companions].map((p) => p.trim().toLowerCase()),
  )
  return selectedFriends.value.filter((f) => involved.has(f.trim().toLowerCase())).length
}

function toggleFriend(friend: string) {
  const i = selectedFriends.value.indexOf(friend)
  if (i === -1) selectedFriends.value.push(friend)
  else selectedFriends.value.splice(i, 1)
  if (selectedFriends.value.length) soloOnly.value = false
}

function toggleSolo() {
  soloOnly.value = !soloOnly.value
  if (soloOnly.value) selectedFriends.value = []
}

function clearGroupFilter() {
  selectedFriends.value = []
  soloOnly.value = false
}

/**
 * How many people the selected group would field for this item: you, plus every
 * selected friend who's actually on it. Compared against the item's minimum.
 */
function partySize(item: MediaItem): number {
  return friendMatches(item) + 1
}

function meetsMinimum(item: MediaItem): boolean {
  if (!item.minPlayers) return true
  return partySize(item) >= item.minPlayers
}

// Drop friends that vanish from the data (e.g. after untagging).
watch(friendOptions, (opts) => {
  selectedFriends.value = selectedFriends.value.filter((f) => opts.includes(f))
})

const filtered = computed(() => {
  let list = [...base.value]
  if (typeFilter.value !== 'all') list = list.filter((m) => m.type === typeFilter.value)
  if (statusFilter.value !== 'all') list = list.filter((m) => m.status === statusFilter.value)
  const q = search.value.trim().toLowerCase()
  if (q) {
    list = list.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.companions.some((c) => c.toLowerCase().includes(q)) ||
        (m.notes ?? '').toLowerCase().includes(q),
    )
  }
  // Solo mode: only things you can actually do on your own.
  if (soloOnly.value) list = list.filter((m) => isSoloable(m))
  // Filtering by friends keeps anything involving at least one of them, and
  // drops anything the resulting group is too small for.
  if (selectedFriends.value.length) {
    list = list.filter((m) => friendMatches(m) > 0 && meetsMinimum(m))
  }
  list.sort((a, b) => {
    // Most overlap with the selected friends wins; everything else tie-breaks.
    if (selectedFriends.value.length) {
      const diff = friendMatches(b) - friendMatches(a)
      if (diff !== 0) return diff
    }
    if (sortBy.value === 'title') return a.title.localeCompare(b.title)
    if (sortBy.value === 'stars') return (b.review?.stars ?? 0) - (a.review?.stars ?? 0)
    const at = a.lastActivityAt || a.createdAt
    const bt = b.lastActivityAt || b.createdAt
    return bt.localeCompare(at)
  })
  return list
})

// Counts per type for the filter chips.
const counts = computed(() => {
  const c: Record<string, number> = { all: base.value.length }
  for (const t of MEDIA_TYPES) c[t] = base.value.filter((m) => m.type === t).length
  return c
})

// --- Add / edit modal --------------------------------------------------------
const showModal = ref(false)
const editing = ref<MediaItem | null>(null)

function openAdd() {
  editing.value = null
  showModal.value = true
}
function openEdit(item: MediaItem) {
  editing.value = item
  showModal.value = true
}

// --- Random spotlight --------------------------------------------------------
const pickedId = ref<string | null>(null)

function pickRandom() {
  const pool = filtered.value
  if (!pool.length) return
  const choice = pool[Math.floor(Math.random() * pool.length)]!
  pickedId.value = choice.id
  nextTick(() => {
    document
      .getElementById(`media-${choice.id}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  // Clear the highlight after the animation so it can be re-triggered.
  setTimeout(() => {
    if (pickedId.value === choice.id) pickedId.value = null
  }, 2500)
}
</script>

<template>
  <div>
    <!-- Header -->
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-3xl font-bold">Your library</h1>
        <p class="mt-1 text-sm opacity-70">
          {{ base.length }} item{{ base.length === 1 ? '' : 's' }} ·
          {{ base.filter((m) => m.status === 'active').length }} active ·
          {{ base.filter((m) => m.status === 'backlog').length }} in backlog
          <span v-if="showTagged && taggedIn.length">
            · {{ taggedIn.length }} you're tagged in
          </span>
        </p>
      </div>
      <div class="flex gap-2">
        <button
          class="btn btn-outline gap-2"
          :disabled="!filtered.length"
          title="Spotlight a random item to pick up"
          @click="pickRandom"
        >
          🎲 Random
        </button>
        <button class="btn btn-primary gap-2" @click="openAdd">＋ Add media</button>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="mb-6 space-y-3">
      <!-- Type chips -->
      <div class="flex flex-wrap gap-2">
        <button
          class="btn btn-sm"
          :class="typeFilter === 'all' ? 'btn-primary' : 'btn-ghost'"
          @click="typeFilter = 'all'"
        >
          All <span class="badge badge-sm ml-1">{{ counts.all }}</span>
        </button>
        <button
          v-for="t in MEDIA_TYPES"
          :key="t"
          class="btn btn-sm"
          :class="typeFilter === t ? 'btn-primary' : 'btn-ghost'"
          @click="typeFilter = t"
        >
          {{ TYPE_META[t].icon }} {{ TYPE_META[t].label }}
          <span class="badge badge-sm ml-1">{{ counts[t] }}</span>
        </button>
      </div>

      <!-- Search / status / sort -->
      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="search"
          type="text"
          placeholder="Search title, person, notes…"
          class="input input-bordered input-sm w-full max-w-xs"
        />
        <select v-model="statusFilter" class="select select-bordered select-sm">
          <option value="all">Any status</option>
          <option value="active">Active</option>
          <option value="backlog">Backlog</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="dropped">Dropped</option>
        </select>
        <select v-model="sortBy" class="select select-bordered select-sm">
          <option value="recent">Recently active</option>
          <option value="title">Title A–Z</option>
          <option value="stars">Highest rated</option>
        </select>

        <!-- Friends multi-select (Solo is useful even with nobody tagged) -->
        <div v-if="base.length" class="dropdown">
          <div
            tabindex="0"
            role="button"
            class="btn btn-sm"
            :class="selectedFriends.length || soloOnly ? 'btn-secondary' : 'btn-outline'"
          >
            <span v-if="soloOnly">🧍 Solo</span>
            <span v-else-if="!selectedFriends.length">👥 Friends</span>
            <span v-else>👥 {{ selectedFriends.join(', ') }}</span>
            <span class="text-xs opacity-60">▾</span>
          </div>
          <div
            tabindex="0"
            class="dropdown-content z-20 mt-1 w-60 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
          >
            <!-- Solo is its own mode -->
            <label
              class="label cursor-pointer justify-start gap-2 rounded-btn px-2 py-1.5 hover:bg-base-200"
              title="Only media you can enjoy on your own"
            >
              <input
                type="checkbox"
                class="checkbox checkbox-xs checkbox-accent"
                :checked="soloOnly"
                @change="toggleSolo"
              />
              <span class="label-text">🧍 Solo</span>
            </label>

            <div class="divider my-1 text-xs opacity-60">or with</div>

            <label
              v-for="friend in friendOptions"
              :key="friend"
              class="label cursor-pointer justify-start gap-2 rounded-btn px-2 py-1.5 hover:bg-base-200"
            >
              <input
                type="checkbox"
                class="checkbox checkbox-xs checkbox-secondary"
                :checked="selectedFriends.includes(friend)"
                @change="toggleFriend(friend)"
              />
              <span class="label-text">{{ friend }}</span>
            </label>

            <p class="px-2 pt-1 text-xs opacity-60">
              Sorted by how many of them are on each item. Media with a group minimum is
              hidden until enough of its people are picked.
            </p>
            <button
              v-if="selectedFriends.length || soloOnly"
              class="btn btn-ghost btn-xs mt-1 w-full"
              @click="clearGroupFilter"
            >
              Clear
            </button>
          </div>
        </div>

        <label
          class="label cursor-pointer gap-2"
          :title="`Include media others have tagged you in (${taggedIn.length})`"
        >
          <input
            v-model="showTagged"
            type="checkbox"
            class="checkbox checkbox-sm checkbox-primary"
          />
          <span class="label-text">Show tagged</span>
          <span v-if="taggedIn.length" class="badge badge-ghost badge-sm">
            {{ taggedIn.length }}
          </span>
        </label>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="pending && !base.length" class="flex justify-center py-20">
      <span class="loading loading-spinner loading-lg" />
    </div>

    <!-- Empty states -->
    <div
      v-else-if="!base.length"
      class="rounded-box border border-dashed border-base-300 py-20 text-center"
    >
      <div class="text-5xl">🍿</div>
      <h2 class="mt-4 text-xl font-semibold">Your library is empty</h2>
      <p class="mt-1 opacity-70">Add the first game, show, movie or book you're into.</p>
      <button class="btn btn-primary mt-4" @click="openAdd">＋ Add your first item</button>
    </div>

    <div
      v-else-if="!filtered.length"
      class="rounded-box border border-dashed border-base-300 py-16 text-center opacity-70"
    >
      Nothing matches those filters.
    </div>

    <!-- Grid -->
    <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="item in filtered" :id="`media-${item.id}`" :key="item.id">
        <MediaCard
          :item="item"
          :editable="canEdit(item)"
          :highlighted="pickedId === item.id"
          @edit="openEdit"
          @deleted="refresh"
        />
      </div>
    </div>

    <MediaFormModal
      v-if="showModal"
      :item="editing"
      @close="showModal = false"
      @saved="refresh"
    />
  </div>
</template>

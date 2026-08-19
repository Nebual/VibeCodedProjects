<script setup lang="ts">
import { PauseIcon, PlayIcon } from '@heroicons/vue/24/solid'

interface SongListItem {
  id: string
  title: string
  rating: number | null
  durationS: number | null
  musicKey: string | null
  timeSignature: string | null
  createdAt: string
  tags: string[]
}

const search = ref('')
const activeTags = ref<string[]>([])

const { data: songsList, refresh: refreshSongs } = await useFetch<SongListItem[]>('/api/songs', {
  query: computed(() => ({
    ...(search.value ? { q: search.value } : {}),
    ...(activeTags.value.length ? { tags: activeTags.value.join(',') } : {}),
  })),
})

const { data: allTags, refresh: refreshAllTags } = await useFetch<{ id: string, name: string }[]>('/api/tags')

function toggleTag(name: string) {
  activeTags.value = activeTags.value.includes(name)
    ? activeTags.value.filter(t => t !== name)
    : [...activeTags.value, name]
}

const { data: me } = useMe()
const player = usePlayer()

// --- Bulk tag editing ---
const selectMode = ref(false)
const selectedIds = ref<string[]>([])
const bulkTagMode = ref<'add' | 'remove'>('add')
const bulkTagNames = ref<string[]>([])
const bulkApplying = ref(false)
const bulkTagPickerRef = useTemplateRef<{ commitPending: () => void }>('bulkTagPicker')

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selectedIds.value = []
}
function toggleSelected(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter(i => i !== id)
    : [...selectedIds.value, id]
}
function onRowClick(e: Event, songId: string) {
  if (!selectMode.value) return
  e.preventDefault()
  toggleSelected(songId)
}

async function applyBulkTags() {
  bulkTagPickerRef.value?.commitPending()
  if (selectedIds.value.length === 0 || bulkTagNames.value.length === 0) return
  bulkApplying.value = true
  try {
    await $fetch('/api/songs/bulk-tags', {
      method: 'POST',
      body: { songIds: selectedIds.value, tagNames: bulkTagNames.value, mode: bulkTagMode.value },
    })
    bulkTagNames.value = []
    selectedIds.value = []
    selectMode.value = false
    await Promise.all([refreshSongs(), refreshAllTags()])
  } finally {
    bulkApplying.value = false
  }
}
</script>

<template>
  <div class="max-w-2xl mx-auto p-4">
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-2xl font-semibold">Your songs</h1>
      <div class="flex gap-2">
        <button
          v-if="songsList?.length"
          class="btn btn-ghost btn-sm"
          @click="toggleSelectMode"
        >
          {{ selectMode ? 'Cancel' : 'Select' }}
        </button>
        <NuxtLink to="/record" class="btn btn-primary btn-sm">Record</NuxtLink>
      </div>
    </div>

    <p v-if="me?.user.status === 'pending'" class="alert alert-info mb-4 text-sm">
      Your account is awaiting admin approval — you can record up to 10 songs in the meantime.
    </p>

    <input
      v-model="search"
      type="text"
      placeholder="Search songs…"
      class="input input-bordered w-full mb-3"
    >

    <div v-if="allTags?.length" class="flex flex-wrap gap-1 mb-4">
      <button
        v-for="t in allTags"
        :key="t.id"
        class="badge cursor-pointer"
        :class="activeTags.includes(t.name) ? 'badge-primary' : 'badge-ghost'"
        @click="toggleTag(t.name)"
      >
        {{ t.name }}
      </button>
    </div>

    <div v-if="selectMode" class="card bg-base-100 shadow-sm p-3 mb-3 flex flex-col gap-2">
      <div class="flex items-center justify-between text-sm">
        <span>{{ selectedIds.length }} selected</span>
        <div class="join">
          <button
            class="join-item btn btn-xs"
            :class="bulkTagMode === 'add' ? 'btn-primary' : ''"
            @click="bulkTagMode = 'add'"
          >
            Add
          </button>
          <button
            class="join-item btn btn-xs"
            :class="bulkTagMode === 'remove' ? 'btn-primary' : ''"
            @click="bulkTagMode = 'remove'"
          >
            Remove
          </button>
        </div>
      </div>
      <div class="flex items-end gap-2">
        <div class="flex-1">
          <TagPicker ref="bulkTagPicker" v-model="bulkTagNames" />
        </div>
        <button
          class="btn btn-sm btn-primary"
          :disabled="selectedIds.length === 0 || bulkApplying"
          @click="applyBulkTags"
        >
          {{ bulkApplying ? 'Applying…' : `${bulkTagMode === 'add' ? 'Add' : 'Remove'} tag${bulkTagNames.length === 1 ? '' : 's'}` }}
        </button>
      </div>
    </div>

    <div v-if="!songsList?.length" class="text-base-content/60 text-center py-12">
      No songs yet. <NuxtLink to="/record" class="link">Record your first one</NuxtLink>.
    </div>

    <ul class="flex flex-col gap-2">
      <li
        v-for="song in songsList"
        :key="song.id"
        class="card card-side bg-base-100 shadow-sm p-3 items-center gap-3"
      >
        <input
          v-if="selectMode"
          type="checkbox"
          class="checkbox checkbox-sm"
          :aria-label="`Select ${song.title}`"
          :checked="selectedIds.includes(song.id)"
          @change="toggleSelected(song.id)"
        >
        <button
          class="btn btn-circle btn-sm"
          :aria-label="player.currentSong.value?.id === song.id && player.isPlaying.value ? 'Pause' : 'Play'"
          @click="player.toggle({ id: song.id, title: song.title, durationS: song.durationS ?? 0 })"
        >
          <PauseIcon v-if="player.currentSong.value?.id === song.id && player.isPlaying.value" class="w-4 h-4" />
          <PlayIcon v-else class="w-4 h-4" />
        </button>
        <NuxtLink
          :to="`/songs/${song.id}`"
          class="flex-1 min-w-0"
          @click="onRowClick($event, song.id)"
        >
          <div class="font-medium truncate">{{ song.title }}</div>
          <div class="text-xs text-base-content/60 flex gap-2 flex-wrap items-center mt-0.5">
            <span v-if="song.durationS">{{ formatDuration(song.durationS) }}</span>
            <span v-if="song.musicKey">{{ song.musicKey }}</span>
            <span v-if="song.timeSignature">{{ song.timeSignature }}</span>
            <span v-for="t in song.tags" :key="t" class="badge badge-ghost badge-xs">{{ t }}</span>
          </div>
        </NuxtLink>
        <div v-if="song.rating" class="text-sm text-warning whitespace-nowrap">★ {{ song.rating }}/10</div>
      </li>
    </ul>
    <div v-if="me?.user?.email?.startsWith('allisonpiano')" class="mt-4 text-xs text-base-content/60 py-1">
      Hi dad! Hope you find this app useful! Send me any feature requests and I'll add em quick :D
    </div>
  </div>
</template>

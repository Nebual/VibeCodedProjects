<script setup lang="ts">
interface AlbumSong {
  id: string
  title: string
  durationS: number | null
  rating: number | null
  position: number
}

interface AlbumDetail {
  id: string
  title: string
  description: string | null
  shareToken: string | null
  songs: AlbumSong[]
}

const route = useRoute()
const albumId = route.params.id as string
const { data: album, refresh } = await useFetch<AlbumDetail>(`/api/albums/${albumId}`)

const player = usePlayer()

const orderedSongs = ref<AlbumSong[]>([])
watchEffect(() => {
  orderedSongs.value = album.value ? [...album.value.songs].sort((a, b) => a.position - b.position) : []
})

async function persistOrder() {
  await $fetch(`/api/albums/${albumId}/songs`, {
    method: 'PUT',
    body: { songIds: orderedSongs.value.map(s => s.id) },
  })
}

let dragIndex: number | null = null
function onDragStart(index: number) {
  dragIndex = index
}
function onDragOver(event: DragEvent) {
  event.preventDefault()
}
async function onDrop(index: number) {
  if (dragIndex === null || dragIndex === index) return
  const list = [...orderedSongs.value]
  const [moved] = list.splice(dragIndex, 1)
  list.splice(index, 0, moved!)
  orderedSongs.value = list
  dragIndex = null
  await persistOrder()
}

// Add-songs picker
const showPicker = ref(false)
const { data: allSongs } = await useFetch<{ id: string, title: string }[]>('/api/songs')
const alreadyIn = computed(() => new Set(orderedSongs.value.map(s => s.id)))

async function addSong(songId: string) {
  const ids = [...orderedSongs.value.map(s => s.id), songId]
  await $fetch(`/api/albums/${albumId}/songs`, { method: 'PUT', body: { songIds: ids } })
  await refresh()
}

async function removeSong(songId: string) {
  const ids = orderedSongs.value.map(s => s.id).filter(id => id !== songId)
  await $fetch(`/api/albums/${albumId}/songs`, { method: 'PUT', body: { songIds: ids } })
  await refresh()
}

// Sharing
const shareUrl = computed(() => {
  if (!album.value?.shareToken) return null
  const slug = slugify(album.value.title)
  return `${location.origin}/a/${album.value.shareToken}#${slug}`
})
const sharing = ref(false)
async function toggleShare() {
  sharing.value = true
  try {
    if (album.value?.shareToken) {
      await $fetch(`/api/albums/${albumId}/share`, { method: 'DELETE' })
    } else {
      await $fetch(`/api/albums/${albumId}/share`, { method: 'POST' })
    }
    await refresh()
  } finally {
    sharing.value = false
  }
}
async function copyShareLink() {
  if (shareUrl.value) await navigator.clipboard.writeText(shareUrl.value)
}
</script>

<template>
  <div v-if="album" class="max-w-xl mx-auto p-4 flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">{{ album.title }}</h1>
      <button class="btn btn-sm" @click="showPicker = true">+ Add songs</button>
    </div>
    <p v-if="album.description" class="text-base-content/70">{{ album.description }}</p>

    <div class="flex items-center gap-2">
      <button class="btn btn-sm" :disabled="sharing" @click="toggleShare">
        {{ album.shareToken ? 'Unshare' : 'Share album' }}
      </button>
      <template v-if="shareUrl">
        <input class="input input-bordered input-sm flex-1" readonly :value="shareUrl">
        <button class="btn btn-sm btn-ghost" @click="copyShareLink">Copy</button>
      </template>
    </div>

    <ul class="flex flex-col gap-1">
      <li
        v-for="(song, index) in orderedSongs"
        :key="song.id"
        draggable="true"
        class="card card-side bg-base-100 shadow-sm p-2 items-center gap-2 cursor-move"
        @dragstart="onDragStart(index)"
        @dragover="onDragOver"
        @drop="onDrop(index)"
      >
        <span class="text-base-content/40">⠿</span>
        <button
          class="btn btn-circle btn-xs"
          @click="player.toggle({ id: song.id, title: song.title, durationS: song.durationS ?? 0 })"
        >
          {{ player.currentSong.value?.id === song.id && player.isPlaying.value ? '⏸' : '▶' }}
        </button>
        <NuxtLink :to="`/songs/${song.id}`" class="flex-1 min-w-0 truncate">{{ song.title }}</NuxtLink>
        <span v-if="song.durationS" class="text-xs text-base-content/60">{{ formatDuration(song.durationS) }}</span>
        <button class="btn btn-ghost btn-xs" @click="removeSong(song.id)">Remove</button>
      </li>
    </ul>

    <dialog class="modal" :open="showPicker">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-3">Add songs</h3>
        <ul class="flex flex-col gap-1 max-h-80 overflow-auto">
          <li
            v-for="s in allSongs?.filter(s => !alreadyIn.has(s.id))"
            :key="s.id"
            class="flex items-center justify-between p-2 hover:bg-base-200 rounded"
          >
            <span>{{ s.title }}</span>
            <button class="btn btn-xs btn-primary" @click="addSong(s.id)">Add</button>
          </li>
        </ul>
        <div class="modal-action">
          <button class="btn" @click="showPicker = false">Done</button>
        </div>
      </div>
    </dialog>
  </div>
</template>

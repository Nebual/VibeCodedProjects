<script setup lang="ts">
import { PauseIcon, PlayIcon } from '@heroicons/vue/24/solid'

interface SongDetail {
  id: string
  title: string
  description: string | null
  musicKey: string | null
  timeSignature: string | null
  rating: number | null
  externalUrl: string | null
  durationS: number | null
  shareToken: string | null
  tags: string[]
}

const route = useRoute()
const songId = route.params.id as string
const { data: song, refresh } = await useFetch<SongDetail>(`/api/songs/${songId}`)

const player = usePlayer()

const form = reactive({
  title: '',
  description: '',
  musicKey: '',
  timeSignature: '',
  rating: 0,
  externalUrl: '',
  tagNames: [] as string[],
})

watchEffect(() => {
  if (!song.value) return
  form.title = song.value.title
  form.description = song.value.description ?? ''
  form.musicKey = song.value.musicKey ?? ''
  form.timeSignature = song.value.timeSignature ?? ''
  form.rating = song.value.rating ?? 0
  form.externalUrl = song.value.externalUrl ?? ''
  form.tagNames = song.value.tags ?? []
})

const saving = ref(false)
async function saveMeta() {
  saving.value = true
  try {
    await $fetch(`/api/songs/${songId}`, { method: 'PATCH', body: { ...form } })
    await refresh()
  } finally {
    saving.value = false
  }
}

function play() {
  if (!song.value) return
  player.toggle({ id: song.value.id, title: song.value.title, durationS: song.value.durationS ?? 0 })
}

const shareUrl = computed(() => {
  if (!song.value?.shareToken) return null
  return `${location.origin}/s/${song.value.shareToken}#${slugify(song.value.title)}`
})
const sharing = ref(false)
async function toggleShare() {
  sharing.value = true
  try {
    if (song.value?.shareToken) {
      await $fetch(`/api/songs/${songId}/share`, { method: 'DELETE' })
    } else {
      await $fetch(`/api/songs/${songId}/share`, { method: 'POST' })
    }
    await refresh()
  } finally {
    sharing.value = false
  }
}
async function copyShareLink() {
  if (shareUrl.value) await navigator.clipboard.writeText(shareUrl.value)
}

function downloadUrl(format: 'mp3' | 'ogg') {
  return `/api/songs/${songId}/download?format=${format}`
}

const router = useRouter()
async function deleteSong() {
  if (!confirm(`Delete "${song.value?.title}"? This can't be undone.`)) return
  await $fetch(`/api/songs/${songId}`, { method: 'DELETE' })
  router.push('/')
}
</script>

<template>
  <div v-if="song" class="max-w-xl mx-auto p-4 flex flex-col gap-4">
    <div class="flex items-center gap-3">
      <button
        class="btn btn-circle btn-primary"
        :aria-label="player.currentSong.value?.id === song.id && player.isPlaying.value ? 'Pause' : 'Play'"
        @click="play"
      >
        <PauseIcon v-if="player.currentSong.value?.id === song.id && player.isPlaying.value" class="w-5 h-5" />
        <PlayIcon v-else class="w-5 h-5" />
      </button>
      <div>
        <h1 class="text-xl font-semibold">{{ song.title }}</h1>
        <p v-if="song.durationS" class="text-sm text-base-content/60">{{ formatDuration(song.durationS) }}</p>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <label class="form-control col-span-2 flex flex-col gap-1">
        <span class="label-text">Title</span>
        <input v-model="form.title" class="input input-bordered input-sm">
      </label>
      <label class="form-control col-span-2 flex flex-col gap-1">
        <span class="label-text">Description</span>
        <textarea v-model="form.description" class="textarea textarea-bordered textarea-sm" rows="2" />
      </label>
      <label class="form-control flex flex-col gap-1">
        <span class="label-text">Key</span>
        <input v-model="form.musicKey" class="input input-bordered input-sm" placeholder="e.g. E♭ major">
      </label>
      <label class="form-control flex flex-col gap-1">
        <span class="label-text">Time signature</span>
        <input v-model="form.timeSignature" class="input input-bordered input-sm" placeholder="e.g. 4/4">
      </label>
      <label class="form-control flex flex-col gap-1">
        <span class="label-text">Rating (0-10)</span>
        <input v-model.number="form.rating" type="number" min="0" max="10" class="input input-bordered input-sm">
      </label>
      <label class="form-control flex flex-col gap-1">
        <span class="label-text">External link</span>
        <input v-model="form.externalUrl" class="input input-bordered input-sm" placeholder="https://soundcloud.com/…">
      </label>
      <div class="col-span-2 flex flex-col gap-1">
        <span class="label-text">Tags</span>
        <TagPicker v-model="form.tagNames" />
      </div>
    </div>

    <button class="btn btn-primary btn-sm self-start" :disabled="saving" @click="saveMeta">
      {{ saving ? 'Saving…' : 'Save changes' }}
    </button>

    <div class="divider" />

    <div class="flex flex-wrap items-center gap-2">
      <a :href="downloadUrl('mp3')" class="btn btn-sm btn-outline">Download MP3</a>
      <a :href="downloadUrl('ogg')" class="btn btn-sm btn-outline">Download OGG</a>
      <button class="btn btn-sm" :disabled="sharing" @click="toggleShare">
        {{ song.shareToken ? 'Unshare' : 'Share link' }}
      </button>
      <button class="btn btn-sm btn-error btn-outline ml-auto" @click="deleteSong">Delete</button>
    </div>
    <div v-if="shareUrl" class="flex items-center gap-2">
      <input class="input input-bordered input-sm flex-1" readonly :value="shareUrl">
      <button class="btn btn-sm btn-ghost" @click="copyShareLink">Copy</button>
    </div>
  </div>
</template>

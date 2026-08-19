<script setup lang="ts">
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

const { data: songsList } = await useFetch<SongListItem[]>('/api/songs', {
  query: computed(() => ({
    ...(search.value ? { q: search.value } : {}),
    ...(activeTags.value.length ? { tags: activeTags.value.join(',') } : {}),
  })),
})

const { data: allTags } = await useFetch<{ id: string, name: string }[]>('/api/tags')

function toggleTag(name: string) {
  activeTags.value = activeTags.value.includes(name)
    ? activeTags.value.filter(t => t !== name)
    : [...activeTags.value, name]
}

const { data: me } = useMe()
const player = usePlayer()
</script>

<template>
  <div class="max-w-2xl mx-auto p-4">
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-2xl font-semibold">Your songs</h1>
      <NuxtLink to="/record" class="btn btn-primary btn-sm">Record</NuxtLink>
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

    <div v-if="!songsList?.length" class="text-base-content/60 text-center py-12">
      No songs yet. <NuxtLink to="/record" class="link">Record your first one</NuxtLink>.
    </div>

    <ul class="flex flex-col gap-2">
      <li
        v-for="song in songsList"
        :key="song.id"
        class="card card-side bg-base-100 shadow-sm p-3 items-center gap-3"
      >
        <button
          class="btn btn-circle btn-sm"
          @click="player.toggle({ id: song.id, title: song.title, durationS: song.durationS ?? 0 })"
        >
          {{ player.currentSong.value?.id === song.id && player.isPlaying.value ? '⏸' : '▶' }}
        </button>
        <NuxtLink :to="`/songs/${song.id}`" class="flex-1 min-w-0">
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
  </div>
</template>

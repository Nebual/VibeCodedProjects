<script setup lang="ts">
definePageMeta({ layout: false })

interface PublicSong {
  id: string
  title: string
  description: string | null
  musicKey: string | null
  timeSignature: string | null
  rating: number | null
  externalUrl: string | null
  durationS: number | null
  tags: string[]
}

const route = useRoute()
const token = route.params.token as string
const { data: song, error } = await useFetch<PublicSong>(`/api/public/songs/${token}`)

useSeoMeta({ robots: 'noindex' })
</script>

<template>
  <div class="min-h-screen bg-base-200 flex items-center justify-center p-4">
    <div v-if="error" class="card w-full max-w-md bg-base-100 shadow-xl">
      <div class="card-body items-center text-center">
        <h1 class="text-xl font-semibold">Link not found</h1>
        <p class="text-base-content/60">This share link is no longer valid.</p>
      </div>
    </div>
    <div v-else-if="song" class="card w-full max-w-md bg-base-100 shadow-xl">
      <div class="card-body gap-3">
        <h1 class="card-title">{{ song.title }}</h1>
        <p v-if="song.description" class="text-base-content/70">{{ song.description }}</p>
        <div class="text-sm text-base-content/60 flex gap-2 flex-wrap">
          <span v-if="song.durationS">{{ formatDuration(song.durationS) }}</span>
          <span v-if="song.musicKey">{{ song.musicKey }}</span>
          <span v-if="song.timeSignature">{{ song.timeSignature }}</span>
          <span v-if="song.rating">★ {{ song.rating }}/10</span>
        </div>
        <div v-if="song.tags.length" class="flex gap-1 flex-wrap">
          <span v-for="t in song.tags" :key="t" class="badge badge-ghost badge-sm">{{ t }}</span>
        </div>
        <audio controls class="w-full mt-2" :src="`/api/public/songs/${token}/audio`" />
        <a v-if="song.externalUrl" :href="song.externalUrl" target="_blank" class="link text-sm">
          {{ song.externalUrl }}
        </a>
      </div>
    </div>
  </div>
</template>

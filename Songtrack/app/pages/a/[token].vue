<script setup lang="ts">
definePageMeta({ layout: false })

interface PublicAlbumSong {
  id: string
  title: string
  durationS: number | null
}

interface PublicAlbum {
  title: string
  description: string | null
  songs: PublicAlbumSong[]
}

const route = useRoute()
const token = route.params.token as string
const { data: album, error } = await useFetch<PublicAlbum>(`/api/public/albums/${token}`)

useSeoMeta({ robots: 'noindex' })

const playingId = ref<string | null>(null)
</script>

<template>
  <div class="min-h-screen bg-base-200 p-4">
    <div class="max-w-xl mx-auto">
      <div v-if="error" class="card bg-base-100 shadow-xl">
        <div class="card-body items-center text-center">
          <h1 class="text-xl font-semibold">Link not found</h1>
          <p class="text-base-content/60">This share link is no longer valid.</p>
        </div>
      </div>
      <div v-else-if="album" class="card bg-base-100 shadow-xl">
        <div class="card-body gap-3">
          <h1 class="card-title">{{ album.title }}</h1>
          <p v-if="album.description" class="text-base-content/70">{{ album.description }}</p>
          <ul class="flex flex-col gap-2 mt-2">
            <li v-for="s in album.songs" :key="s.id" class="flex flex-col gap-1">
              <div class="flex items-center justify-between">
                <button class="link text-left" @click="playingId = playingId === s.id ? null : s.id">
                  {{ s.title }}
                </button>
                <span v-if="s.durationS" class="text-xs text-base-content/60">{{ formatDuration(s.durationS) }}</span>
              </div>
              <audio
                v-if="playingId === s.id"
                controls
                autoplay
                class="w-full"
                :src="`/api/public/albums/${token}/songs/${s.id}/audio`"
              />
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

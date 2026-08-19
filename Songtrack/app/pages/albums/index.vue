<script setup lang="ts">
interface AlbumListItem {
  id: string
  title: string
  description: string | null
}

const { data: albumsList, refresh } = await useFetch<AlbumListItem[]>('/api/albums')

const newTitle = ref('')
const creating = ref(false)
async function createAlbum() {
  const title = newTitle.value.trim()
  if (!title) return
  creating.value = true
  try {
    const { id } = await $fetch<{ id: string }>('/api/albums', { method: 'POST', body: { title } })
    newTitle.value = ''
    await refresh()
    await navigateTo(`/albums/${id}`)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="max-w-2xl mx-auto p-4">
    <h1 class="text-2xl font-semibold mb-4">Albums</h1>

    <div class="flex gap-2 mb-6">
      <input
        v-model="newTitle"
        type="text"
        placeholder="New album title…"
        class="input input-bordered flex-1"
        @keydown.enter="createAlbum"
      >
      <button class="btn btn-primary" :disabled="creating || !newTitle.trim()" @click="createAlbum">
        Create
      </button>
    </div>

    <div v-if="!albumsList?.length" class="text-base-content/60 text-center py-12">
      No albums yet.
    </div>

    <ul class="flex flex-col gap-2">
      <li v-for="album in albumsList" :key="album.id">
        <NuxtLink :to="`/albums/${album.id}`" class="card bg-base-100 shadow-sm p-3 block">
          <div class="font-medium">{{ album.title }}</div>
          <div v-if="album.description" class="text-xs text-base-content/60 truncate">{{ album.description }}</div>
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>

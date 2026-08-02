<script setup lang="ts">
import type { BookDetail, BookSummary } from '~/types/api'

const { data: books, refresh } = await useFetch<BookSummary[]>('/api/books', {
  default: () => [],
})

const uploading = ref(false)
const uploadError = ref<string | null>(null)
const dragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function upload(file: File) {
  if (!file.name.toLowerCase().endsWith('.epub')) {
    uploadError.value = 'That is not an .epub file.'
    return
  }

  uploading.value = true
  uploadError.value = null
  try {
    const form = new FormData()
    form.append('file', file)
    const book = await $fetch<BookDetail>('/api/books', { method: 'POST', body: form })
    await navigateTo(`/books/${book.id}`)
  }
  catch (e: unknown) {
    const err = e as { data?: { detail?: string, message?: string } }
    uploadError.value = err.data?.detail ?? err.data?.message ?? 'Upload failed.'
  }
  finally {
    uploading.value = false
  }
}

function onDrop(event: DragEvent) {
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) upload(file)
}

function onPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) upload(file)
}

async function remove(book: BookSummary) {
  if (!confirm(`Delete "${book.title}"? This removes the uploaded file and all extracted text.`)) {
    return
  }
  await $fetch(`/api/books/${book.id}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div class="space-y-8">
    <section>
      <h1 class="text-2xl font-semibold">
        Library
      </h1>
      <p class="text-base-content/60 mt-1 text-sm">
        Upload an EPUB, check how it was split into chapters, then convert it.
      </p>
    </section>

    <!-- Upload -->
    <section
      class="rounded-box border-2 border-dashed p-8 text-center transition-colors"
      :class="dragging ? 'border-primary bg-primary/5' : 'border-base-300 bg-base-100'"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input
        ref="fileInput"
        type="file"
        accept=".epub,application/epub+zip"
        class="hidden"
        @change="onPick"
      >

      <div v-if="uploading" class="flex flex-col items-center gap-3">
        <span class="loading loading-spinner loading-lg text-primary" />
        <p class="text-sm">
          Parsing…
        </p>
      </div>

      <div v-else class="space-y-3">
        <p class="text-base-content/70 text-sm">
          Drop an <code>.epub</code> here
        </p>
        <button class="btn btn-primary btn-sm" @click="fileInput?.click()">
          Choose a file
        </button>
      </div>

      <div v-if="uploadError" class="alert alert-error mt-4 text-left text-sm">
        <span>{{ uploadError }}</span>
      </div>
    </section>

    <!-- Books -->
    <section v-if="books.length" class="space-y-3">
      <h2 class="text-base-content/60 text-xs font-medium uppercase tracking-wide">
        {{ books.length }} book{{ books.length === 1 ? '' : 's' }}
      </h2>

      <NuxtLink
        v-for="book in books"
        :key="book.id"
        :to="`/books/${book.id}`"
        class="card card-side bg-base-100 hover:bg-base-100/70 shadow-sm transition-colors"
      >
        <figure class="w-20 shrink-0 self-stretch bg-base-300">
          <img
            v-if="book.has_cover"
            :src="`/api/books/${book.id}/cover`"
            :alt="`Cover of ${book.title}`"
            class="h-full w-full object-cover"
          >
        </figure>

        <div class="card-body flex-row items-center gap-4 py-4">
          <div class="min-w-0 flex-1">
            <h3 class="truncate font-medium">
              {{ book.title }}
            </h3>
            <p class="text-base-content/60 truncate text-sm">
              {{ book.authors.join(', ') || 'Unknown author' }}
            </p>
            <p class="text-base-content/40 mt-1 text-xs">
              {{ book.chapter_count }} chapters ·
              {{ words(book.included_words) }} words to narrate ·
              ~{{ duration(book.est_seconds) }}
            </p>
          </div>
          <button
            class="btn btn-ghost btn-xs text-error"
            @click.prevent="remove(book)"
          >
            Delete
          </button>
        </div>
      </NuxtLink>
    </section>

    <p v-else class="text-base-content/40 py-8 text-center text-sm">
      No books yet.
    </p>
  </div>
</template>

<script setup lang="ts">
import type { BookDetail, ChapterInfo, ChapterText } from '~/types/api'

const route = useRoute()
const id = route.params.id as string

const { data: book, error } = await useFetch<BookDetail>(`/api/books/${id}`)

// Remembered across visits: a global default, overridden per book once you
// have chosen for this one.
const { model, voice, speed } = useVoicePreference(id)

/** Index of the chapter whose extracted text is expanded, if any. */
const openChapter = ref<number | null>(null)
const preview = ref<ChapterText | null>(null)
const previewLoading = ref(false)
const busy = ref(false)

async function togglePreview(chapter: ChapterInfo) {
  if (openChapter.value === chapter.index) {
    openChapter.value = null
    return
  }
  openChapter.value = chapter.index
  previewLoading.value = true
  preview.value = null
  try {
    preview.value = await $fetch<ChapterText>(
      `/api/books/${id}/chapters/${chapter.index}/text`,
    )
  }
  finally {
    previewLoading.value = false
  }
}

async function setInclude(chapter: ChapterInfo, include: boolean) {
  busy.value = true
  try {
    book.value = await $fetch<BookDetail>(
      `/api/books/${id}/chapters/${chapter.index}`,
      { method: 'PATCH', body: { include } },
    )
  }
  finally {
    busy.value = false
  }
}

async function setAll(include: boolean) {
  if (!book.value) return
  busy.value = true
  try {
    book.value = await $fetch<BookDetail>(`/api/books/${id}/chapters`, {
      method: 'PATCH',
      body: { indices: book.value.chapters.map(c => c.index), include },
    })
  }
  finally {
    busy.value = false
  }
}

const includedCount = computed(
  () => book.value?.chapters.filter(c => c.include).length ?? 0,
)
</script>

<template>
  <div v-if="error" class="alert alert-error">
    <span>Could not load this book. It may have been deleted.</span>
  </div>

  <div v-else-if="book" class="space-y-6">
    <NuxtLink to="/" class="link link-hover text-base-content/60 text-sm">
      ← Library
    </NuxtLink>

    <!-- Header -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body flex-row gap-5">
        <img
          v-if="book.has_cover"
          :src="`/api/books/${book.id}/cover`"
          :alt="`Cover of ${book.title}`"
          class="rounded-box hidden h-40 w-28 object-cover sm:block"
        >
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-semibold">
            {{ book.title }}
          </h1>
          <p class="text-base-content/60">
            {{ book.authors.join(', ') || 'Unknown author' }}
          </p>

          <div class="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div>
              <div class="text-base-content/40 text-xs uppercase tracking-wide">
                Chapters
              </div>
              <div>{{ includedCount }} of {{ book.chapter_count }}</div>
            </div>
            <div>
              <div class="text-base-content/40 text-xs uppercase tracking-wide">
                Words to narrate
              </div>
              <div>{{ words(book.included_words) }}</div>
            </div>
            <div>
              <div class="text-base-content/40 text-xs uppercase tracking-wide">
                Estimated audio
              </div>
              <div>~{{ duration(book.est_seconds) }}</div>
            </div>
            <div v-if="book.publisher">
              <div class="text-base-content/40 text-xs uppercase tracking-wide">
                Publisher
              </div>
              <div>{{ book.publisher }}</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Narration -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body gap-3">
        <div>
          <h2 class="card-title text-base">
            Narration
          </h2>
        </div>
        <VoicePicker
          v-model:model="model"
          v-model:voice="voice"
          v-model:speed="speed"
          :book-id="book.id"
          :est-seconds="book.est_seconds"
        />
      </div>
    </section>

    <RenderPanel
      :book-id="book.id"
      :model="model"
      :voice="voice"
      :speed="speed"
      :included-chapters="includedCount"
    />

    <div v-if="book.toc_synthesised" class="alert alert-warning text-sm">
      <span>
        This EPUB has no usable table of contents, so chapters were inferred from the
        spine. Titles are guesses — check them carefully.
      </span>
    </div>

    <!-- Chapters -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body gap-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="card-title text-base">
              Chapters
            </h2>
            <p class="text-base-content/50 text-xs">
              Untick anything that should not be narrated. Click a title to read the
              extracted text.
            </p>
          </div>
          <div class="join">
            <button class="btn btn-xs join-item" :disabled="busy" @click="setAll(true)">
              Include all
            </button>
            <button class="btn btn-xs join-item" :disabled="busy" @click="setAll(false)">
              Exclude all
            </button>
          </div>
        </div>

        <ul class="divide-base-200 divide-y">
          <li v-for="chapter in book.chapters" :key="chapter.index">
            <div class="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                class="checkbox checkbox-sm"
                :checked="chapter.include"
                :disabled="busy"
                :aria-label="`Include ${chapter.title}`"
                @change="setInclude(chapter, ($event.target as HTMLInputElement).checked)"
              >

              <button
                class="min-w-0 flex-1 text-left"
                @click="togglePreview(chapter)"
              >
                <div
                  class="truncate text-sm"
                  :class="chapter.include ? '' : 'text-base-content/40 line-through'"
                >
                  {{ chapter.title }}
                </div>
                <div class="text-base-content/40 flex flex-wrap gap-2 text-xs">
                  <span v-if="chapter.section">{{ chapter.section }}</span>
                  <span>{{ words(chapter.word_count) }} words</span>
                  <span>~{{ duration(chapter.est_seconds) }}</span>
                  <span v-if="chapter.skip_reason" class="text-warning">
                    {{ chapter.skip_reason }}
                  </span>
                </div>
              </button>

              <span class="text-base-content/30 font-mono text-xs">
                {{ String(chapter.index).padStart(2, '0') }}
              </span>
            </div>

            <!-- Extracted text -->
            <div v-if="openChapter === chapter.index" class="pb-4 pl-9">
              <div v-if="previewLoading" class="loading loading-dots loading-sm" />
              <div v-else-if="preview" class="space-y-3">
                <div class="text-base-content/40 text-xs">
                  {{ preview.paragraphs.length }} paragraphs from
                  <code>{{ chapter.sources.join(', ') }}</code>
                </div>
                <div
                  class="bg-base-200 rounded-box max-h-96 space-y-2 overflow-y-auto p-4 text-sm leading-relaxed"
                >
                  <p v-for="(para, i) in preview.paragraphs" :key="i">
                    {{ para }}
                  </p>
                </div>
              </div>
            </div>
          </li>
        </ul>
      </div>
    </section>

    <p class="text-base-content/40 text-center text-xs">
      Conversion arrives in Phase 2. This screen exists so a bad parse is caught before
      hours of rendering.
    </p>
  </div>
</template>

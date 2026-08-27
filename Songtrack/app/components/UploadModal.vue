<script setup lang="ts">
import { ArrowUpTrayIcon } from '@heroicons/vue/24/outline'
import { normalizeYoutubeUrl, parseYoutubeUrls } from '#shared/utils/youtube'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const {
  queue: uploadQueue,
  isUploading,
  pendingCount: uploadsPending,
  allSettled: uploadsAllSettled,
  enqueue,
  enqueueYoutube,
  retry: retryUpload,
  dismiss: dismissUpload,
  clearFinished: clearFinishedUploads,
} = useUploadQueue()
const fileInputRef = useTemplateRef<HTMLInputElement>('fileInput')

const tab = ref<'files' | 'youtube'>('files')
const youtubeText = ref('')
/** Rejected lines from the last Import press, shown so a typo isn't silently dropped. */
const youtubeErrors = ref<string[]>([])

function onFilesChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) enqueue(files)
  input.value = '' // allow re-picking the same file(s)
}

function importYoutube() {
  const candidates = parseYoutubeUrls(youtubeText.value)
  const valid: string[] = []
  const errors: string[] = []
  for (const candidate of candidates) {
    const parsed = normalizeYoutubeUrl(candidate)
    if (parsed.ok) valid.push(candidate)
    else errors.push(parsed.reason)
  }
  youtubeErrors.value = errors
  if (!valid.length) return
  enqueueYoutube(valid)
  // Only clear the box when every line was accepted, so bad lines stay editable.
  if (!errors.length) youtubeText.value = ''
}

function requestClose() {
  // Closing mid-upload keeps the queue running in the background (the composable
  // lives as long as the app layout); reopening shows live progress again.
  emit('close')
}
</script>

<template>
  <dialog class="modal" :open="props.open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-bold text-lg flex items-center gap-2">
          <ArrowUpTrayIcon class="w-5 h-5" /> Upload songs
        </h3>
        <button class="btn btn-circle btn-sm btn-ghost" aria-label="Close" @click="requestClose">✕</button>
      </div>

      <div role="tablist" class="tabs tabs-box mb-3">
        <button
          role="tab"
          class="tab"
          :class="{ 'tab-active': tab === 'files' }"
          :aria-selected="tab === 'files'"
          @click="tab = 'files'"
        >Files</button>
        <button
          role="tab"
          class="tab"
          :class="{ 'tab-active': tab === 'youtube' }"
          :aria-selected="tab === 'youtube'"
          @click="tab = 'youtube'"
        >YouTube</button>
      </div>

      <template v-if="tab === 'files'">
        <input
          ref="fileInput"
          type="file"
          accept="audio/*,.mp3,.ogg,.m4a,.wav,.flac,.aac,.opus,.wma"
          multiple
          class="file-input file-input-bordered file-input-sm w-full"
          @change="onFilesChosen"
        >
        <p class="text-xs text-base-content/60 mt-1">
          Select several files at once — each becomes its own song, uploaded one by one.
        </p>
      </template>

      <template v-else>
        <textarea
          v-model="youtubeText"
          class="textarea textarea-bordered textarea-sm w-full font-mono text-xs"
          rows="4"
          aria-label="YouTube links"
          placeholder="https://www.youtube.com/watch?v=…&#10;https://youtu.be/…"
        />
        <div class="flex items-center justify-between gap-2 mt-1">
          <p class="text-xs text-base-content/60">
            One link per line — each becomes its own song, imported one by one.
          </p>
          <button
            class="btn btn-sm btn-primary"
            :disabled="!youtubeText.trim()"
            @click="importYoutube"
          >Import</button>
        </div>
        <ul v-if="youtubeErrors.length" class="mt-2 flex flex-col gap-1">
          <li v-for="(err, i) in youtubeErrors" :key="i" class="text-xs text-error">{{ err }}</li>
        </ul>
      </template>

      <ul v-if="uploadQueue.length" class="flex flex-col gap-1 mt-3 max-h-72 overflow-y-auto">
        <li
          v-for="item in uploadQueue"
          :key="item.key"
          class="rounded-box bg-base-300/60 px-3 py-2 text-sm"
        >
          <div class="flex items-center gap-2">
            <span
              v-if="item.status === 'uploading'"
              class="loading loading-spinner loading-xs shrink-0"
              :aria-label="item.source.kind === 'youtube' ? 'Importing' : 'Uploading'"
            />
            <span v-else-if="item.status === 'done'" class="text-success shrink-0" aria-label="Done">✓</span>
            <span v-else-if="item.status === 'error'" class="text-error shrink-0" aria-label="Failed">✕</span>
            <span v-else class="shrink-0 opacity-50">…</span>

            <NuxtLink
              v-if="item.songId"
              :to="`/songs/${item.songId}`"
              class="flex-1 truncate hover:underline"
              @click="$emit('close')"
            >{{ item.title }}</NuxtLink>
            <span v-else class="flex-1 truncate" :class="{ 'opacity-60': item.status === 'error' }">
              {{ item.title }}
            </span>

            <button
              v-if="item.status === 'error'"
              class="btn btn-xs btn-ghost text-warning"
              @click="retryUpload(item.key)"
            >Retry</button>
            <button
              v-if="item.status === 'done' || item.status === 'error'"
              class="btn btn-xs btn-circle btn-ghost"
              aria-label="Dismiss"
              @click="dismissUpload(item.key)"
            >
              ✕
            </button>
          </div>
          <!-- The server's own message ("That video is longer than…") is the useful part; a
               truncated title alone leaves the user with no idea why an item failed. -->
          <p v-if="item.status === 'error' && item.error" class="text-xs text-error mt-1 pl-6">
            {{ item.error }}
          </p>
        </li>
      </ul>

      <p v-if="uploadQueue.length && isUploading" class="text-xs text-base-content/60 mt-2">
        {{ uploadsPending + 1 }} song{{ uploadsPending ? 's' : '' }} remaining…
      </p>
      <div
        v-if="uploadsAllSettled && uploadQueue.some(i => i.status === 'done')"
        class="flex justify-end gap-2 mt-3"
      >
        <NuxtLink to="/" class="btn btn-sm btn-primary" @click="$emit('close')">Back to songs</NuxtLink>
        <button class="btn btn-sm btn-ghost" @click="clearFinishedUploads">Clear list</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop" @click.prevent="$emit('close')">
      <button aria-label="Close upload dialog" />
    </form>
  </dialog>
</template>

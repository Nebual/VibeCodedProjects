<script setup lang="ts">
import { ArrowUpTrayIcon } from '@heroicons/vue/24/outline'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const {
  queue: uploadQueue,
  isUploading,
  pendingCount: uploadsPending,
  allSettled: uploadsAllSettled,
  enqueue,
  retry: retryUpload,
  dismiss: dismissUpload,
  clearFinished: clearFinishedUploads,
} = useUploadQueue()
const fileInputRef = useTemplateRef<HTMLInputElement>('fileInput')

function onFilesChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) enqueue(files)
  input.value = '' // allow re-picking the same file(s)
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

      <ul v-if="uploadQueue.length" class="flex flex-col gap-1 mt-3 max-h-72 overflow-y-auto">
        <li
          v-for="item in uploadQueue"
          :key="item.key"
          class="flex items-center gap-2 rounded-box bg-base-300/60 px-3 py-2 text-sm"
        >
          <span
            v-if="item.status === 'uploading'"
            class="loading loading-spinner loading-xs shrink-0"
            aria-label="Uploading"
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
          <span v-else class="flex-1 truncate" :class="{ 'line-through opacity-60': item.status === 'error' }">
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
        </li>
      </ul>

      <p v-if="uploadQueue.length && isUploading" class="text-xs text-base-content/60 mt-2">
        Uploading {{ uploadsPending + 1 }} song{{ uploadsPending ? 's' : '' }} remaining…
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

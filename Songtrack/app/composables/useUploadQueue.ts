/**
 * Client-side queue for bulk song uploads.
 *
 * Files are appended to `queue` from a multi-file <input>; uploads run STRICTLY one at a
 * time (concurrency 1) so a folder-drop of hundreds of songs doesn't hammer the server
 * with parallel ffmpeg renders. Each file becomes its own song via POST /api/songs/upload,
 * which streams the body to disk and renders master.ogg + peaks inline before responding —
 * so the returned id is fully playable immediately (no polling).
 *
 * State per item: queued → uploading → done | error. Failed items stay in the list and can
 * be retried; done items can be dismissed. The user can navigate away mid-queue without
 * losing progress already made, but in-flight uploads will abort on page unload (browser
 * default), landing that item back as an error it can retry.
 */
export interface UploadQueueItem {
  /** Stable per-item key for :key / retry bookkeeping. */
  key: string
  file: File
  title: string
  status: 'queued' | 'uploading' | 'done' | 'error'
  error?: string
  songId?: string
}

export function useUploadQueue() {
  const queue = ref<UploadQueueItem[]>([])
  const isUploading = computed(() => queue.value.some(i => i.status === 'uploading'))
  const pendingCount = computed(() => queue.value.filter(i => i.status === 'queued').length)
  /** Flips true once all items reach done/error; consumed by the UI to offer navigation. */
  const allSettled = ref(false)

  let running = false

  function enqueue(files: File[]) {
    allSettled.value = false
    for (const file of files) {
      queue.value.push({
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
        // Strip the extension — the filename is usually "Song name.mp3".
        title: file.name.replace(/\.[^.]+$/, '') || 'Untitled upload',
        status: 'queued',
      })
    }
    void pump()
  }

  async function pump() {
    if (running) return
    running = true
    try {
      for (;;) {
        const next = queue.value.find(i => i.status === 'queued')
        if (!next) break
        next.status = 'uploading'
        try {
          const { id } = await $fetch<{ id: string }>('/api/songs/upload', {
            method: 'POST',
            query: { title: next.title, mime: next.file.type || '', filename: next.file.name },
            body: next.file,
          })
          next.songId = id
          next.status = 'done'
        } catch (e) {
          next.status = 'error'
          next.error = e instanceof Error ? e.message : 'Upload failed'
        }
      }
      allSettled.value = true
    } finally {
      running = false
    }
  }

  function retry(key: string) {
    const item = queue.value.find(i => i.key === key)
    if (!item || item.status !== 'error') return
    item.status = 'queued'
    item.error = undefined
    allSettled.value = false
    void pump()
  }

  /** Remove one settled (done/error) item from the visible list. */
  function dismiss(key: string) {
    queue.value = queue.value.filter(i => i.key !== key)
  }

  /** Clear finished items only — queued/in-flight uploads keep their place. */
  function clearFinished() {
    queue.value = queue.value.filter(i => i.status === 'queued' || i.status === 'uploading')
  }

  return { queue, isUploading, pendingCount, allSettled, enqueue, retry, dismiss, clearFinished }
}

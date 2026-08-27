/**
 * Client-side queue for bulk song ingest — local files and YouTube imports alike.
 *
 * Items are appended from a multi-file <input> or a paste of YouTube links; they run
 * STRICTLY one at a time (concurrency 1) so a folder-drop of hundreds of songs doesn't
 * hammer the server with parallel ffmpeg renders, and a paste of twenty links doesn't start
 * twenty downloads. Each item becomes its own song: files via POST /api/songs/upload,
 * links via POST /api/songs/import-youtube. Both endpoints stream/download to disk and
 * render master.ogg + peaks inline before responding — so the returned id is fully playable
 * immediately (no polling).
 *
 * State per item: queued → uploading → done | error. Failed items stay in the list and can
 * be retried; done items can be dismissed. The user can navigate away mid-queue without
 * losing progress already made, but in-flight work will abort on page unload (browser
 * default), landing that item back as an error it can retry.
 */

/** What an item is ingesting — a picked file, or a link the server downloads for us. */
export type UploadSource =
  | { kind: 'file', file: File }
  | { kind: 'youtube', url: string }

export interface UploadQueueItem {
  /** Stable per-item key for :key / retry bookkeeping. */
  key: string
  source: UploadSource
  /** Shown in the list. For YouTube this starts as the link and is replaced by the real video title. */
  title: string
  status: 'queued' | 'uploading' | 'done' | 'error'
  error?: string
  songId?: string
}

let keySeq = 0
function nextKey(prefix: string) {
  return `${prefix}-${keySeq++}-${Math.random().toString(36).slice(2)}`
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
        key: nextKey(file.name),
        source: { kind: 'file', file },
        // Strip the extension — the filename is usually "Song name.mp3".
        title: file.name.replace(/\.[^.]+$/, '') || 'Untitled upload',
        status: 'queued',
      })
    }
    void pump()
  }

  /** Queue one song per YouTube link. Titles arrive from the server once each import finishes. */
  function enqueueYoutube(urls: string[]) {
    allSettled.value = false
    for (const url of urls) {
      queue.value.push({
        key: nextKey('yt'),
        source: { kind: 'youtube', url },
        title: url,
        status: 'queued',
      })
    }
    void pump()
  }

  async function runItem(item: UploadQueueItem) {
    if (item.source.kind === 'file') {
      const { file } = item.source
      const { id } = await $fetch<{ id: string }>('/api/songs/upload', {
        method: 'POST',
        query: { title: item.title, mime: file.type || '', filename: file.name },
        body: file,
      })
      item.songId = id
      return
    }
    const { id, title } = await $fetch<{ id: string, title: string }>('/api/songs/import-youtube', {
      method: 'POST',
      body: { url: item.source.url },
    })
    item.songId = id
    // Swap the raw link for the video's real title now that the server knows it.
    if (title) item.title = title
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
          await runItem(next)
          next.status = 'done'
        } catch (e) {
          next.status = 'error'
          next.error = uploadErrorMessage(e, next.source.kind)
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

  return { queue, isUploading, pendingCount, allSettled, enqueue, enqueueYoutube, retry, dismiss, clearFinished }
}

/**
 * $fetch wraps a failed response as "[POST] ... 502 Bad Gateway" — useless in a list. The
 * server's own statusMessage (e.g. "That video is longer than the 60 minute import limit.")
 * is the part worth showing, so prefer it whenever it came back.
 */
function uploadErrorMessage(e: unknown, kind: UploadSource['kind']): string {
  const fallback = kind === 'youtube' ? 'Import failed' : 'Upload failed'
  if (e && typeof e === 'object') {
    const data = (e as { data?: { statusMessage?: string, message?: string } }).data
    const fromServer = data?.statusMessage || data?.message
    if (fromServer) return fromServer
    const statusMessage = (e as { statusMessage?: string }).statusMessage
    if (statusMessage) return statusMessage
  }
  return e instanceof Error ? e.message : fallback
}

import { nanoid } from 'nanoid'
import {
  activeTakeAt,
  resolveTimeline,
  timelineDuration,
  punchInOverwriteAmount,
} from '#shared/utils/timeline'

export interface RecordedTake {
  id: string
  timelineStart: number
  duration: number
  mimeType: string
  blob: Blob | null
  /** RMS amplitude buckets at BUCKET_RATE Hz, local to this take's own timeline. */
  rms: number[]
}

export const BUCKET_RATE = 10 // waveform buckets per second

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

async function acquireMicStream(): Promise<MediaStream> {
  const constraints: MediaTrackConstraints = {
    echoCancellation: { exact: false },
    noiseSuppression: { exact: false },
    autoGainControl: { exact: false },
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints })
  } catch {
    // Some browsers reject `exact: false`; fall back to unconstrained booleans.
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
    })
  }
}

export function useRecorder() {
  const sessionId = nanoid()

  const state = ref<'idle' | 'recording' | 'paused'>('idle')
  const takes = ref<RecordedTake[]>([])
  const currentTakeId = ref<string | null>(null)
  const isClipping = ref(false)
  const reviewPosition = ref(0)
  const isReviewPlaying = ref(false)
  const error = ref<string | null>(null)
  const recoverableSessionId = ref<string | null>(null)

  let stream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let activeChunks: Blob[] = []
  let chunkIndex = 0
  let takeStartedAt = 0
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let rmsIntervalId: ReturnType<typeof setInterval> | null = null
  let wakeLock: WakeLockSentinel | null = null
  let rafId: number | null = null
  const audioEls = new Map<string, HTMLAudioElement>()
  const tickNow = ref(performance.now())
  let tickIntervalId: ReturnType<typeof setInterval> | null = null

  function startTicking() {
    tickIntervalId = setInterval(() => { tickNow.value = performance.now() }, 100)
  }
  function stopTicking() {
    if (tickIntervalId) clearInterval(tickIntervalId)
    tickIntervalId = null
  }

  const timelineTakes = computed(() =>
    takes.value.map(t => ({ id: t.id, timelineStart: t.timelineStart, duration: t.duration })),
  )
  const elapsedTotal = computed(() => timelineDuration(timelineTakes.value))

  /** Live-ticking duration to show as the big number: growing while recording, frozen at the scrub position while paused. */
  const displayDuration = computed(() => {
    if (state.value === 'recording') {
      const take = takes.value.find(t => t.id === currentTakeId.value)
      if (take) return take.timelineStart + (tickNow.value - takeStartedAt) / 1000
    }
    if (state.value === 'paused') return reviewPosition.value
    return elapsedTotal.value
  })
  const punchInWarning = computed(() => {
    if (state.value !== 'paused') return 0
    return punchInOverwriteAmount(timelineTakes.value, reviewPosition.value)
  })

  /** Last ~10s of RMS buckets for the take currently being recorded. */
  const rollingWaveform = computed(() => {
    const take = takes.value.find(t => t.id === currentTakeId.value)
    if (!take) return []
    return take.rms.slice(-10 * BUCKET_RATE)
  })

  /** Full resolved-timeline waveform, stitched from whichever take wins each range. */
  const reviewWaveform = computed(() => {
    const segments = resolveTimeline(
      takes.value.map(t => ({ id: t.id, timelineStart: t.timelineStart, duration: t.duration })),
    )
    const buckets: number[] = []
    for (const seg of segments) {
      const take = takes.value.find(t => t.id === seg.source)
      if (!take) continue
      const from = Math.floor(seg.start * BUCKET_RATE)
      const to = Math.floor(seg.end * BUCKET_RATE)
      buckets.push(...take.rms.slice(from, to))
    }
    return buckets
  })

  async function acquireWakeLock() {
    try {
      wakeLock = await navigator.wakeLock?.request('screen')
    } catch {
      // Not fatal — recording still works, just without the screen-stays-on guarantee.
    }
  }

  function releaseWakeLock() {
    wakeLock?.release().catch(() => {})
    wakeLock = null
  }

  async function onVisibilityChange() {
    if (document.visibilityState === 'visible' && state.value === 'recording' && !wakeLock) {
      await acquireWakeLock()
    }
  }

  function startRmsSampling(take: RecordedTake) {
    if (!audioCtx && stream) {
      audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
    }
    if (!analyser) return
    const buf = new Uint8Array(analyser.fftSize)
    rmsIntervalId = setInterval(() => {
      analyser!.getByteTimeDomainData(buf)
      let sumSquares = 0
      let clipCount = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i]! - 128) / 128
        sumSquares += v * v
        if (Math.abs(v) > 0.98) clipCount++
      }
      take.rms.push(Math.sqrt(sumSquares / buf.length))
      isClipping.value = clipCount > 3
    }, 1000 / BUCKET_RATE)
  }

  function stopRmsSampling() {
    if (rmsIntervalId) clearInterval(rmsIntervalId)
    rmsIntervalId = null
    isClipping.value = false
  }

  async function persistManifest() {
    await opfsWriteManifest(sessionId, {
      takes: takes.value.map(t => ({
        id: t.id,
        timelineStart: t.timelineStart,
        duration: t.duration,
        mimeType: t.mimeType,
        chunkCount: t.id === currentTakeId.value ? chunkIndex : -1,
      })),
    })
  }

  async function beginTake(timelineStart: number) {
    if (!stream) stream = await acquireMicStream()
    const mimeType = pickMimeType()
    const take: RecordedTake = { id: nanoid(), timelineStart, duration: 0, mimeType, blob: null, rms: [] }
    takes.value.push(take)
    currentTakeId.value = take.id
    activeChunks = []
    chunkIndex = 0

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 192_000 } : undefined)
    recorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        activeChunks.push(e.data)
        const idx = chunkIndex++
        await opfsWriteChunk(sessionId, take.id, idx, e.data)
        await persistManifest()
      }
    }
    recorder.start(5000)
    mediaRecorder = recorder
    takeStartedAt = performance.now()
    startRmsSampling(take)
    startTicking()
  }

  function endTake(): Promise<void> {
    return new Promise((resolve) => {
      const recorder = mediaRecorder
      const take = takes.value.find(t => t.id === currentTakeId.value)
      if (!recorder || !take) {
        resolve()
        return
      }
      recorder.onstop = async () => {
        take.duration = (performance.now() - takeStartedAt) / 1000
        take.blob = new Blob(activeChunks, { type: take.mimeType })
        stopRmsSampling()
        stopTicking()
        await persistManifest()
        resolve()
      }
      recorder.stop()
    })
  }

  async function start() {
    error.value = null
    try {
      await opfsPersist()
      await acquireWakeLock()
      await beginTake(0)
      state.value = 'recording'
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Could not access the microphone.'
    }
  }

  async function pause() {
    if (state.value !== 'recording') return
    await endTake()
    state.value = 'paused'
    reviewPosition.value = elapsedTotal.value
  }

  async function resume() {
    if (state.value !== 'paused' || isReviewPlaying.value) return
    pauseReview()
    await beginTake(reviewPosition.value)
    state.value = 'recording'
  }

  function stopAllAudioEls() {
    for (const el of audioEls.values()) el.pause()
  }

  function getAudioEl(take: RecordedTake): HTMLAudioElement | null {
    if (!take.blob) return null
    let el = audioEls.get(take.id)
    if (!el) {
      el = new Audio(URL.createObjectURL(take.blob))
      audioEls.set(take.id, el)
    }
    return el
  }

  function seekReview(position: number) {
    reviewPosition.value = Math.min(Math.max(position, 0), elapsedTotal.value)
    stopAllAudioEls()
    const active = activeTakeAt(timelineTakes.value, reviewPosition.value)
    if (!active) return
    const take = takes.value.find(t => t.id === active.id)
    const el = take && getAudioEl(take)
    if (el) {
      el.currentTime = active.localTime
      if (isReviewPlaying.value) el.play().catch(() => {})
    }
  }

  function reviewTick() {
    if (!isReviewPlaying.value) return
    const active = activeTakeAt(timelineTakes.value, reviewPosition.value)
    if (active) {
      const el = audioEls.get(active.id)
      if (el) {
        const take = takes.value.find(t => t.id === active.id)!
        const timelinePos = take.timelineStart + el.currentTime
        reviewPosition.value = timelinePos
        if (timelinePos >= elapsedTotal.value - 0.05) {
          pauseReview()
          reviewPosition.value = elapsedTotal.value
          return
        }
        const stillActive = activeTakeAt(timelineTakes.value, timelinePos)
        if (stillActive && stillActive.id !== active.id) {
          seekReview(timelinePos)
        }
      }
    }
    rafId = requestAnimationFrame(reviewTick)
  }

  function playReview() {
    if (state.value !== 'paused') return
    isReviewPlaying.value = true
    if (reviewPosition.value >= elapsedTotal.value - 0.01) reviewPosition.value = 0
    seekReview(reviewPosition.value)
    reviewTick()
  }

  function pauseReview() {
    isReviewPlaying.value = false
    stopAllAudioEls()
    if (rafId) cancelAnimationFrame(rafId)
    rafId = null
  }

  function seekToEnd() {
    pauseReview()
    seekReview(elapsedTotal.value)
  }

  async function discard() {
    pauseReview()
    stream?.getTracks().forEach(t => t.stop())
    releaseWakeLock()
    await opfsDeleteSession(sessionId)
  }

  async function checkForOrphanedSession() {
    const sessions = await opfsListSessions()
    const other = sessions.find(s => s !== sessionId)
    recoverableSessionId.value = other ?? null
  }

  async function recoverSession(id: string) {
    const manifest = await opfsReadManifest(id)
    if (!manifest) return
    for (const t of manifest.takes) {
      const blob = await opfsReadTakeBlob(id, t.id, t.mimeType)
      takes.value.push({ id: t.id, timelineStart: t.timelineStart, duration: t.duration, mimeType: t.mimeType, blob, rms: [] })
    }
    state.value = 'paused'
    reviewPosition.value = elapsedTotal.value
    recoverableSessionId.value = null
    // Recovered audio uploads under the *original* session id so its OPFS files get cleaned up on save.
    await opfsDeleteSession(sessionId)
  }

  async function discardOrphanedSession(id: string) {
    await opfsDeleteSession(id)
    recoverableSessionId.value = null
  }

  async function uploadTake(songId: string, take: RecordedTake, ordinal: number) {
    const { id: takeId } = await $fetch<{ id: string }>(`/api/songs/${songId}/takes`, { method: 'POST' })
    const blob = take.blob!
    const CHUNK_SIZE = 2 * 1024 * 1024
    let idx = 0
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
      const chunk = blob.slice(offset, offset + CHUNK_SIZE)
      await $fetch(`/api/songs/${songId}/takes/${takeId}/chunk`, {
        method: 'PUT',
        query: { index: idx },
        body: chunk,
      })
      idx++
    }
    await $fetch(`/api/songs/${songId}/takes/${takeId}/finalize`, {
      method: 'POST',
      body: { timelineStart: take.timelineStart, ordinal, mimeType: take.mimeType, duration: take.duration },
    })
  }

  async function save(opts: { title: string, tagNames: string[] }): Promise<string> {
    if (state.value === 'recording') await pause()
    if (takes.value.length === 0) throw new Error('Nothing recorded yet.')

    const { id: songId } = await $fetch<{ id: string }>('/api/songs', {
      method: 'POST',
      body: { title: opts.title, tagNames: opts.tagNames },
    })

    for (let i = 0; i < takes.value.length; i++) {
      await uploadTake(songId, takes.value[i]!, i)
    }

    await $fetch(`/api/songs/${songId}/finalize`, { method: 'POST' })

    stream?.getTracks().forEach(t => t.stop())
    releaseWakeLock()
    await opfsDeleteSession(sessionId)

    return songId
  }

  if (import.meta.client) {
    document.addEventListener('visibilitychange', onVisibilityChange)
    onScopeDispose(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      stream?.getTracks().forEach(t => t.stop())
      releaseWakeLock()
      pauseReview()
      stopTicking()
      audioCtx?.close().catch(() => {})
    })
  }

  return {
    state,
    takes,
    error,
    isClipping,
    elapsedTotal,
    displayDuration,
    rollingWaveform,
    reviewWaveform,
    reviewPosition,
    isReviewPlaying,
    punchInWarning,
    recoverableSessionId,
    start,
    pause,
    resume,
    discard,
    save,
    playReview,
    pauseReview,
    seekReview,
    seekToEnd,
    checkForOrphanedSession,
    recoverSession,
    discardOrphanedSession,
  }
}

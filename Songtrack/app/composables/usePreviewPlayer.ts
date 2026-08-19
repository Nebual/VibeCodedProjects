/**
 * One boosted, seekable playback slot backed by a single `Audio` element —
 * shared by every ad-hoc preview clip on the edit page (noise-panel A/B
 * previews, auto-trim cut previews) so they all get transport controls and
 * the same monitoring-gain boost as the main waveform, instead of a
 * fire-and-forget `new Audio().play()` with no seek/pause.
 */
export function usePreviewPlayer() {
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const loading = ref(false)

  let el: HTMLAudioElement | null = null
  let gainNode: GainNode | null = null
  let currentUrl: string | null = null

  function ensureEl(): HTMLAudioElement {
    if (!el) {
      el = new Audio()
      el.addEventListener('timeupdate', () => { currentTime.value = el!.currentTime })
      el.addEventListener('loadedmetadata', () => { duration.value = el!.duration })
      el.addEventListener('play', () => { isPlaying.value = true })
      el.addEventListener('pause', () => { isPlaying.value = false })
      el.addEventListener('ended', () => { isPlaying.value = false })
      gainNode = useMonitorGain().wrapElement(el)
    }
    return el
  }

  function revokeCurrentUrl() {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl)
      currentUrl = null
    }
  }

  async function loadAndPlay(blob: Blob) {
    const audioEl = ensureEl()
    const { ensureAudioCtx, gainForBuffer } = useMonitorGain()
    const ctx = ensureAudioCtx()
    loading.value = true
    try {
      // Decoding is only to estimate a monitoring gain from the actual content — playback
      // itself still streams from the element's own `src` below, decoded independently.
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
      if (gainNode) gainNode.gain.value = gainForBuffer(buffer)
    } catch {
      if (gainNode) gainNode.gain.value = 1
    }
    revokeCurrentUrl()
    currentUrl = URL.createObjectURL(blob)
    audioEl.src = currentUrl
    loading.value = false
    await ctx.resume()
    await audioEl.play()
  }

  function toggle() {
    if (!el) return
    if (isPlaying.value) el.pause()
    else el.play().catch(() => {})
  }

  function stop() {
    el?.pause()
    if (el) el.currentTime = 0
  }

  function seek(time: number) {
    if (el) el.currentTime = time
  }

  onScopeDispose(() => {
    stop()
    revokeCurrentUrl()
  })

  return { isPlaying, currentTime, duration, loading, loadAndPlay, toggle, stop, seek }
}

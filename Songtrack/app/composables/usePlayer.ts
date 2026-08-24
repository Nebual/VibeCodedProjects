export interface PlayableSong {
  id: string
  title: string
  durationS: number
}

// Module-scope singleton (not useState) — this is client-only interactive
// state that must survive route navigation, not something SSR needs to hydrate.
const currentSong = ref<PlayableSong | null>(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const playbackRate = ref(1)
const loop = ref(false)

let audioEl: HTMLAudioElement | null = null
// Preview-loudness normalization, shared with the Edit page's monitorGain — moving either slider
// updates the same targetLevelDb, and both recompute gain from this song's own peaks.
const monitorGain = useMonitorGain()
let masterGainNode: GainNode | null = null
let currentPeaks: Float32Array | null = null

function ensureAudioEl(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio()
    audioEl.addEventListener('timeupdate', () => { currentTime.value = audioEl!.currentTime })
    audioEl.addEventListener('loadedmetadata', () => { duration.value = audioEl!.duration })
    audioEl.addEventListener('play', () => { isPlaying.value = true })
    audioEl.addEventListener('pause', () => { isPlaying.value = false })
    audioEl.addEventListener('ended', () => { isPlaying.value = false })
    masterGainNode = monitorGain.wrapElement(audioEl)
  }
  return audioEl
}

if (import.meta.client) {
  watch(monitorGain.targetLevelDb, () => {
    if (masterGainNode && currentPeaks) masterGainNode.gain.value = monitorGain.gainForPeaks(currentPeaks)
  })
}

export function usePlayer() {
  function play(song: PlayableSong) {
    const el = ensureAudioEl()
    if (currentSong.value?.id !== song.id) {
      currentSong.value = song
      el.src = `/api/songs/${song.id}/audio`
      el.playbackRate = playbackRate.value
      el.loop = loop.value
      // Reset to unity until this song's own peaks resolve, so the previous song's gain
      // never briefly gets applied to different material.
      currentPeaks = null
      if (masterGainNode) masterGainNode.gain.value = 1
      $fetch<{ data: number[] }>(`/api/songs/${song.id}/peaks`).then((peaks) => {
        if (currentSong.value?.id !== song.id) return // superseded by another song already
        currentPeaks = peaksToFloatArray(peaks.data)
        if (masterGainNode) masterGainNode.gain.value = monitorGain.gainForPeaks(currentPeaks)
      }).catch(() => {}) // peaks not generated yet — play at unity gain
    }
    el.play().catch(() => {})
  }

  function pause() {
    audioEl?.pause()
  }

  function toggle(song: PlayableSong) {
    if (currentSong.value?.id === song.id && isPlaying.value) pause()
    else play(song)
  }

  function seek(time: number) {
    if (audioEl) audioEl.currentTime = time
  }

  function skip(deltaSeconds: number) {
    if (audioEl) {
      audioEl.currentTime = Math.min(Math.max(0, audioEl.currentTime + deltaSeconds), duration.value || Infinity)
    }
  }

  function setPlaybackRate(rate: number) {
    playbackRate.value = rate
    if (audioEl) audioEl.playbackRate = rate
  }

  function setLoop(value: boolean) {
    loop.value = value
    if (audioEl) audioEl.loop = value
  }

  return {
    currentSong,
    isPlaying,
    currentTime,
    duration,
    playbackRate,
    loop,
    play,
    pause,
    toggle,
    seek,
    skip,
    setPlaybackRate,
    setLoop,
  }
}

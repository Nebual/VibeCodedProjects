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

function ensureAudioEl(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio()
    audioEl.addEventListener('timeupdate', () => { currentTime.value = audioEl!.currentTime })
    audioEl.addEventListener('loadedmetadata', () => { duration.value = audioEl!.duration })
    audioEl.addEventListener('play', () => { isPlaying.value = true })
    audioEl.addEventListener('pause', () => { isPlaying.value = false })
    audioEl.addEventListener('ended', () => { isPlaying.value = false })
  }
  return audioEl
}

export function usePlayer() {
  function play(song: PlayableSong) {
    const el = ensureAudioEl()
    if (currentSong.value?.id !== song.id) {
      currentSong.value = song
      el.src = `/api/songs/${song.id}/audio`
      el.playbackRate = playbackRate.value
      el.loop = loop.value
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

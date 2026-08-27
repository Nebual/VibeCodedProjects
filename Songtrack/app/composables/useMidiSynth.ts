import { Sequencer, WorkletSynthesizer } from 'spessasynth_lib'
// Vite serves the AudioWorklet processor as its own URL; it can't be bundled into the main graph.
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url'

/**
 * In-browser MIDI playback through the SoundFont the sidecar serves.
 *
 * Everything here is lazy and failure-tolerant on purpose: the soundfont is a 38 MB proxied
 * download that is unavailable whenever the sidecar is (local dev, the e2e suite), and the page
 * has to stay usable without it — the piano roll, the tempo editor and the downloads don't need a
 * synth at all.
 */
export function useMidiSynth() {
  const ready = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const playing = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)

  let ctx: AudioContext | null = null
  let synth: WorkletSynthesizer | null = null
  let sequencer: Sequencer | null = null
  let gain: GainNode | null = null
  let raf = 0

  async function init(): Promise<boolean> {
    if (ready.value) return true
    if (loading.value) return false
    loading.value = true
    error.value = null
    try {
      const res = await fetch('/api/midi/soundfont')
      if (!res.ok) throw new Error(`soundfont unavailable (${res.status})`)
      const soundfont = await res.arrayBuffer()

      ctx = new AudioContext()
      await ctx.audioWorklet.addModule(processorUrl)
      synth = new WorkletSynthesizer(ctx)
      gain = ctx.createGain()
      synth.connect(gain)
      gain.connect(ctx.destination)
      await synth.soundBankManager.addSoundBank(soundfont, 'main')
      await synth.isReady
      ready.value = true
      return true
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : 'Could not start the synthesiser'
      return false
    }
    finally {
      loading.value = false
    }
  }

  function tick() {
    if (sequencer) {
      currentTime.value = sequencer.currentTime
      if (sequencer.isFinished) playing.value = false
    }
    if (playing.value) raf = requestAnimationFrame(tick)
  }

  /** Loads a MIDI file (raw bytes) into the sequencer without starting it. */
  async function load(midi: ArrayBuffer): Promise<boolean> {
    if (!await init()) return false
    if (!synth) return false
    sequencer?.pause()
    sequencer = new Sequencer(synth, { autoPlay: false })
    sequencer.loadNewSongList([{ binary: midi }])
    duration.value = sequencer.duration
    currentTime.value = 0
    playing.value = false
    return true
  }

  async function play() {
    if (!sequencer || !ctx) return
    await ctx.resume()
    sequencer.play()
    playing.value = true
    raf = requestAnimationFrame(tick)
  }

  function pause() {
    sequencer?.pause()
    playing.value = false
    cancelAnimationFrame(raf)
  }

  function seek(seconds: number) {
    if (!sequencer) return
    sequencer.currentTime = seconds
    currentTime.value = seconds
  }

  /** 0 = silent, 1 = full. The synth half of the crossfade. */
  function setVolume(value: number) {
    if (gain && ctx) gain.gain.setTargetAtTime(value, ctx.currentTime, 0.01)
  }

  function destroy() {
    cancelAnimationFrame(raf)
    sequencer?.pause()
    synth?.destroy()
    ctx?.close().catch(() => {})
    ctx = null
    synth = null
    sequencer = null
    ready.value = false
  }

  onScopeDispose(destroy)

  return { ready, loading, error, playing, currentTime, duration, load, play, pause, seek, setVolume }
}

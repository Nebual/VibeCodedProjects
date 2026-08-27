import { WorkletSynthesizer } from 'spessasynth_lib'
// Vite serves the AudioWorklet processor as its own URL; it can't be bundled into the main graph.
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url'
import type { TranscribedNote } from '#shared/types'
import { DRUM_CHANNEL, assignChannels, gmProgramFor, isDrumInstrument } from '#shared/utils/instruments'

/**
 * Plays transcribed notes through the SoundFont the sidecar serves.
 *
 * Deliberately a note scheduler rather than a `Sequencer` over a MIDI file, because the three
 * things this page needs are all awkward through a sequencer and natural here: hearing a
 * transcription *while it is still streaming in*, muting individual instruments, and running on a
 * clock borrowed from the original recording so the two stay in sync.
 *
 * Note events are scheduled on the **audio context clock** (`{ time }` on noteOn/noteOff), not
 * with setTimeout, so they land where they're meant to instead of drifting by however long the
 * main thread was busy.
 *
 * Everything is lazy and failure-tolerant: the soundfont is a 38 MB proxied download that is
 * unavailable whenever the sidecar is, and the roll, the tempo editor and the downloads all have
 * to work without it.
 */

/** How far ahead notes are queued. Short enough that a mute or a seek feels immediate. */
const LOOKAHEAD_S = 0.3
const TICK_MS = 100
/** MIDI controller 7, channel volume — how a part is muted without touching its scheduling. */
const CC_VOLUME = 7

export interface MidiSynthOptions {
  /**
   * Where playback is, in song seconds. Supply the original recording's clock and the synth
   * follows it, correcting drift on every tick instead of slowly sliding out of step.
   */
  clock?: () => number
}

export function useMidiSynth(options: MidiSynthOptions = {}) {
  const ready = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const playing = ref(false)
  const currentTime = ref(0)
  const mutedInstruments = ref<string[]>([])

  let ctx: AudioContext | null = null
  let synth: WorkletSynthesizer | null = null
  let gain: GainNode | null = null

  let notes: TranscribedNote[] = []
  let channels = new Map<string, number>()
  /** Song time up to which notes have already been queued; everything before it is spoken for. */
  let scheduledUpTo = 0
  /** Internal clock origin, used only when no external clock is supplied. */
  let originCtx = 0
  let originSong = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let raf = 0

  function songTime(): number {
    if (options.clock) return options.clock()
    if (!ctx || !playing.value) return originSong
    return originSong + (ctx.currentTime - originCtx)
  }

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
      applyPatches()
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

  /** Point each channel at the right General MIDI programme, so a bass isn't a piano. */
  function applyPatches() {
    if (!synth) return
    for (const [instrument, channel] of channels) {
      if (isDrumInstrument(instrument)) continue
      synth.programChange(channel, gmProgramFor(instrument))
    }
    applyMutes()
  }

  function applyMutes() {
    if (!synth) return
    for (const [instrument, channel] of channels) {
      const volume = mutedInstruments.value.includes(instrument) ? 0 : 127
      // Channel volume, not "skip the note": this takes effect instantly, including for notes
      // already sounding and for anything already queued on the audio clock, which cannot be
      // un-queued.
      synth.controllerChange(channel, CC_VOLUME as never, volume)
    }
  }

  /**
   * Replaces the note list. Safe to call repeatedly while notes stream in — already-queued notes
   * stay queued, and anything new beyond `scheduledUpTo` is picked up on the next tick.
   */
  function setNotes(next: TranscribedNote[]) {
    notes = [...next].sort((a, b) => a.start - b.start)
    const instruments = [...new Set(notes.map(n => n.instrument))]
    const before = channels.size
    channels = assignChannels(instruments)
    if (channels.size !== before) applyPatches()
  }

  function scheduleWindow() {
    if (!ctx || !synth || !playing.value) return
    const now = songTime()
    currentTime.value = now
    const horizon = now + LOOKAHEAD_S

    for (const note of notes) {
      if (note.start <= scheduledUpTo || note.start > horizon) continue
      const channel = channels.get(note.instrument) ?? 0
      // Recomputed against the live clock every tick, so if the external clock drifts (or the
      // user scrubs the recording) the notes follow it rather than the other way round.
      const at = ctx.currentTime + (note.start - now)
      const until = ctx.currentTime + (note.end - now)
      if (at < ctx.currentTime) continue
      // Velocity isn't recovered by the tokenizer at all, so everything is one flat mezzo-forte.
      synth.noteOn(channel, note.pitch, 90, { time: at })
      synth.noteOff(channel, note.pitch, { time: Math.max(until, at + 0.02) })
    }
    scheduledUpTo = horizon
  }

  function tickPlayhead() {
    if (!playing.value) return
    currentTime.value = songTime()
    raf = requestAnimationFrame(tickPlayhead)
  }

  async function play(from?: number) {
    if (!await init()) return
    if (!ctx) return
    await ctx.resume()
    const start = from ?? songTime()
    originCtx = ctx.currentTime
    originSong = start
    scheduledUpTo = start
    playing.value = true
    applyPatches()
    scheduleWindow()
    timer = setInterval(scheduleWindow, TICK_MS)
    raf = requestAnimationFrame(tickPlayhead)
  }

  function pause() {
    playing.value = false
    clearInterval(timer)
    cancelAnimationFrame(raf)
    synth?.stopAll(true)
    originSong = currentTime.value
  }

  function seek(seconds: number) {
    const wasPlaying = playing.value
    if (wasPlaying) pause()
    originSong = seconds
    currentTime.value = seconds
    scheduledUpTo = seconds
    if (wasPlaying) play(seconds)
  }

  function toggleInstrument(instrument: string) {
    const i = mutedInstruments.value.indexOf(instrument)
    if (i === -1) mutedInstruments.value.push(instrument)
    else mutedInstruments.value.splice(i, 1)
    applyMutes()
  }

  /** 0 = silent, 1 = full. The synth half of the crossfade. */
  function setVolume(value: number) {
    if (gain && ctx) gain.gain.setTargetAtTime(value, ctx.currentTime, 0.01)
  }

  function destroy() {
    clearInterval(timer)
    cancelAnimationFrame(raf)
    playing.value = false
    synth?.stopAll(true)
    synth?.destroy()
    ctx?.close().catch(() => {})
    ctx = null
    synth = null
    ready.value = false
  }

  onScopeDispose(destroy)

  return {
    ready,
    loading,
    error,
    playing,
    currentTime,
    mutedInstruments,
    init,
    setNotes,
    play,
    pause,
    seek,
    toggleInstrument,
    setVolume,
  }
}

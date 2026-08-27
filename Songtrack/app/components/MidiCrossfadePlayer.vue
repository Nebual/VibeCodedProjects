<script setup lang="ts">
import type { TranscribedNote } from '#shared/types'
import { instrumentLabel } from '#shared/utils/instruments'

/**
 * Plays the transcription against the original recording, with one slider between them.
 *
 * Driven by *notes*, not by a MIDI file, which is what lets it play a transcription that is still
 * streaming in — and what fixed the bug where a revisit was silent, because the MIDI bytes only
 * ever arrived on the run that streamed them.
 *
 * The recording is the clock. The synth reads `audio.currentTime` on every scheduling tick, so
 * scrubbing the recording drags the transcription with it and the two cannot drift apart.
 */
const props = defineProps<{
  songId: string
  notes: TranscribedNote[]
  /** Seconds; used to size the scrubber before the audio element has its metadata. */
  duration?: number
  /** True while transcription is still running — enables the play-as-it-arrives preview. */
  live?: boolean
}>()

const emit = defineEmits<{
  time: [seconds: number]
  /** So the roll can grey out the parts you've switched off. */
  'update:muted': [instruments: string[]]
}>()

const audioRef = useTemplateRef<HTMLAudioElement>('audio')
const synth = useMidiSynth({ clock: () => audioRef.value?.currentTime ?? 0 })

/** 0 = original only, 1 = transcription only. */
const blend = ref(0.5)
const playing = ref(false)
const position = ref(0)

const instruments = computed(() => [...new Set(props.notes.map(n => n.instrument))].sort())

watch(() => props.notes, notes => synth.setNotes(notes), { immediate: true, deep: false })

watchEffect(() => {
  synth.setVolume(blend.value)
  if (audioRef.value) audioRef.value.volume = 1 - blend.value
})

watch(synth.currentTime, (t) => { emit('time', t) })
watch(synth.mutedInstruments, v => emit('update:muted', [...v]), { deep: true })

async function toggle() {
  if (playing.value) return stop()
  const audio = audioRef.value
  if (!audio) return
  // Start the recording first, then hand the synth the position it actually reached — starting
  // both from a number decided in advance is what put them out of step before.
  await audio.play().catch(() => {})
  await synth.play(audio.currentTime)
  playing.value = true
}

function stop() {
  audioRef.value?.pause()
  synth.pause()
  playing.value = false
}

/** Jump both to the same place. Called by the roll's click-to-seek as well as the scrubber. */
function seek(seconds: number) {
  const audio = audioRef.value
  if (audio) audio.currentTime = seconds
  synth.seek(seconds)
  position.value = seconds
}

function onTimeUpdate() {
  position.value = audioRef.value?.currentTime ?? 0
}

const total = computed(() => props.duration || audioRef.value?.duration || 0)

defineExpose({ seek, stop })
</script>

<template>
  <div class="flex flex-col gap-2 p-3 rounded-box bg-base-200" data-testid="crossfade-player">
    <audio
      ref="audio"
      :src="`/api/songs/${songId}/audio`"
      preload="metadata"
      @timeupdate="onTimeUpdate"
      @ended="stop"
    />

    <div class="flex items-center gap-3">
      <button
        class="btn btn-sm btn-primary"
        data-testid="crossfade-toggle"
        :disabled="!notes.length"
        @click="toggle"
      >
        {{ playing ? 'Pause' : live ? 'Preview so far' : 'Play both' }}
      </button>
      <div class="flex-1 flex items-center gap-2">
        <span class="text-xs whitespace-nowrap">Recording</span>
        <input v-model.number="blend" type="range" min="0" max="1" step="0.01" class="range range-xs flex-1">
        <span class="text-xs whitespace-nowrap">Transcription</span>
      </div>
    </div>

    <input
      v-if="total"
      class="range range-xs"
      type="range" min="0" :max="total" step="0.01"
      :value="position"
      data-testid="seek"
      @input="seek(Number(($event.target as HTMLInputElement).value))"
    >

    <div v-if="instruments.length > 1" class="flex flex-wrap items-center gap-1.5">
      <span class="text-xs text-base-content/60 mr-1">Hear:</span>
      <button
        v-for="name in instruments"
        :key="name"
        class="btn btn-xs"
        :class="synth.mutedInstruments.value.includes(name) ? 'btn-outline opacity-50' : 'btn-primary'"
        :data-testid="`mute-${name}`"
        @click="synth.toggleInstrument(name)"
      >
        {{ instrumentLabel(name) }}
      </button>
    </div>

    <p v-if="synth.loading.value" class="text-xs text-base-content/60">Loading the synthesiser…</p>
    <p v-else-if="synth.error.value" class="text-xs text-warning" data-testid="synth-error">
      In-browser playback is unavailable ({{ synth.error.value }}) — the slider only controls the
      original recording. The downloads below still work.
    </p>
  </div>
</template>

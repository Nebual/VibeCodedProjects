<script setup lang="ts">
/**
 * Plays the transcription against the original recording, with one slider between them.
 *
 * A wrong grid sounds mechanically wrong in a way the eye can miss on the piano roll, and a
 * missed or invented note is far easier to hear against the source than to spot in the notes —
 * so the two are deliberately mixed rather than offered as separate players.
 *
 * Degrades to "just the original" when the soundfont can't be fetched, which is the normal state
 * whenever the sidecar isn't running.
 */
const props = defineProps<{
  songId: string
  /** Raw bytes of the performance MIDI, decoded from the transcription_complete frame. */
  midi: ArrayBuffer | null
}>()

const synth = useMidiSynth()
const audioRef = useTemplateRef<HTMLAudioElement>('audio')

/** 0 = original only, 1 = transcription only. */
const blend = ref(0.5)
const loaded = ref(false)

watch(() => props.midi, async (midi) => {
  loaded.value = midi ? await synth.load(midi.slice(0)) : false
}, { immediate: true })

watchEffect(() => {
  synth.setVolume(blend.value)
  if (audioRef.value) audioRef.value.volume = 1 - blend.value
})

const playing = ref(false)

async function toggle() {
  if (playing.value) {
    synth.pause()
    audioRef.value?.pause()
    playing.value = false
    return
  }
  // Start both from the same point so the comparison is meaningful.
  const at = audioRef.value?.currentTime ?? 0
  synth.seek(at)
  if (loaded.value) await synth.play()
  await audioRef.value?.play().catch(() => {})
  playing.value = true
}

function onEnded() {
  synth.pause()
  playing.value = false
}

defineExpose({ currentTime: computed(() => audioRef.value?.currentTime ?? 0) })
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="crossfade-player">
    <audio ref="audio" :src="`/api/songs/${songId}/audio`" preload="metadata" @ended="onEnded" />

    <div class="flex items-center gap-3">
      <button class="btn btn-sm btn-primary" data-testid="crossfade-toggle" @click="toggle">
        {{ playing ? 'Pause' : 'Play both' }}
      </button>
      <div class="flex-1 flex items-center gap-2">
        <span class="text-xs whitespace-nowrap">Recording</span>
        <input v-model.number="blend" type="range" min="0" max="1" step="0.01" class="range range-xs flex-1">
        <span class="text-xs whitespace-nowrap">Transcription</span>
      </div>
    </div>

    <p v-if="synth.loading.value" class="text-xs text-base-content/60">Loading the synthesiser…</p>
    <p v-else-if="synth.error.value" class="text-xs text-warning" data-testid="synth-error">
      In-browser playback is unavailable ({{ synth.error.value }}) — the slider only controls the
      original recording. The downloads below still work.
    </p>
  </div>
</template>

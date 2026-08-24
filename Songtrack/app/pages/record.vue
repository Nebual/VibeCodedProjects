<script setup lang="ts">
import { PauseIcon, PlayIcon } from '@heroicons/vue/24/solid'
import { ForwardIcon, XMarkIcon } from '@heroicons/vue/24/outline'

definePageMeta({ layout: false })

const recorder = useRecorder()
const {
  state,
  takes,
  error,
  isClipping,
  displayDuration,
  elapsedTotal,
  rollingWaveform,
  reviewWaveform,
  reviewPosition,
  isReviewPlaying,
  isPreviewReady,
  punchInWarning,
  recoverableSessionId,
  noiseRegion,
  ambienceManuallySet,
} = recorder

const router = useRouter()

onMounted(() => {
  recorder.checkForOrphanedSession()
})

const showCancelConfirm = ref(false)
function requestCancel() {
  if (state.value === 'idle' && takes.value.length === 0) {
    router.push('/')
    return
  }
  showCancelConfirm.value = true
}
async function confirmCancel() {
  await recorder.discard()
  showCancelConfirm.value = false
  router.push('/')
}

const showSaveSheet = ref(false)
const saveTitle = ref('')
const saveTags = ref<string[]>([])
const saving = ref(false)
const saveError = ref<string | null>(null)
const tagPickerRef = useTemplateRef<{ commitPending: () => void }>('tagPicker')

async function openSaveSheet() {
  if (state.value === 'recording') await recorder.pause()
  // A name typed into the inline field already covers the one required field in
  // the sheet — skip straight to saving instead of asking for it a second time.
  // Tags can still be added afterward from the song page.
  if (saveTitle.value.trim()) {
    await confirmSave()
    return
  }
  showSaveSheet.value = true
}

async function confirmSave() {
  if (!saveTitle.value.trim()) return
  tagPickerRef.value?.commitPending()
  saving.value = true
  saveError.value = null
  try {
    const songId = await recorder.save({ title: saveTitle.value, tagNames: saveTags.value })
    router.push(`/songs/${songId}`)
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Could not save the recording.'
  } finally {
    saving.value = false
  }
}

// The scrubber shows a locally-held value while the user is actively
// dragging, so the RAF-driven playhead position (while playing) can't fight
// the drag gesture. Dragging pauses playback first, then resumes it on
// release — the standard scrub UX, and it sidesteps the fight entirely.
const isDragging = ref(false)
const dragValue = ref(0)
const wasPlayingBeforeDrag = ref(false)
const sliderValue = computed(() => (isDragging.value ? dragValue.value : reviewPosition.value))

function onScrubStart() {
  isDragging.value = true
  wasPlayingBeforeDrag.value = isReviewPlaying.value
  dragValue.value = reviewPosition.value
  if (isReviewPlaying.value) recorder.pauseReview()
}
function onScrubInput(e: Event) {
  const value = Number((e.target as HTMLInputElement).value)
  dragValue.value = value
  recorder.seekReview(value)
}
function onScrubEnd() {
  isDragging.value = false
  if (wasPlayingBeforeDrag.value) recorder.playReview()
}

const hasContent = computed(() => state.value !== 'idle' || takes.value.length > 0)
</script>

<template>
  <div class="h-dvh max-w-md mx-auto p-4 flex flex-col gap-4 overflow-y-auto">
    <div class="flex items-center justify-between">
      <button class="btn btn-ghost btn-sm btn-circle" aria-label="Cancel" @click="requestCancel">
        <XMarkIcon class="w-5 h-5" />
      </button>
      <span v-if="hasContent" class="text-sm text-base-content/60">
        {{ state === 'recording' ? 'Recording…' : state === 'paused' ? 'Paused' : '' }}
      </span>
      <div class="w-8" />
    </div>

    <div v-if="recoverableSessionId" class="alert alert-warning flex-col items-start gap-2">
      <span>A previous recording wasn't saved. Recover it?</span>
      <div class="flex gap-2">
        <button class="btn btn-xs btn-primary" @click="recorder.recoverSession(recoverableSessionId!)">
          Recover
        </button>
        <button class="btn btn-xs" @click="recorder.discardOrphanedSession(recoverableSessionId!)">
          Discard
        </button>
      </div>
    </div>

    <p v-if="error" class="alert alert-error text-sm">{{ error }}</p>

    <div class="text-center text-5xl font-mono font-semibold tabular-nums my-4">
      {{ formatDuration(displayDuration) }}
    </div>

    <div class="h-20 bg-base-300 rounded-box overflow-hidden relative">
      <WaveformCanvas
        v-if="state === 'paused'"
        :buckets="reviewWaveform"
        :progress="elapsedTotal > 0 ? sliderValue / elapsedTotal : 0"
      />
      <WaveformCanvas
        v-else
        :buckets="rollingWaveform"
        :color="isClipping ? 'oklch(65% 0.2 25)' : undefined"
      />
    </div>

    <div v-if="state === 'paused'" class="flex flex-col gap-2">
      <input
        type="range"
        class="range range-sm w-full"
        min="0"
        :max="elapsedTotal"
        step="0.05"
        :value="sliderValue"
        @pointerdown="onScrubStart"
        @input="onScrubInput"
        @pointerup="onScrubEnd"
      >
      <div class="flex items-center justify-between">
        <button
          class="btn btn-sm btn-circle"
          :disabled="!isPreviewReady"
          :aria-label="isReviewPlaying ? 'Pause' : 'Play'"
          @click="isReviewPlaying ? recorder.pauseReview() : recorder.playReview()"
        >
          <span v-if="!isPreviewReady" class="loading loading-spinner loading-xs" />
          <PauseIcon v-else-if="isReviewPlaying" class="w-4 h-4" />
          <PlayIcon v-else class="w-4 h-4" />
        </button>
        <button
          v-if="reviewPosition < elapsedTotal - 0.05"
          class="btn btn-sm gap-1"
          @click="recorder.seekToEnd"
        >
          <ForwardIcon class="w-4 h-4" /> Seek to end
        </button>
      </div>
    </div>

    <div class="flex-1 flex items-center justify-center py-4">
      <button
        v-if="state === 'idle'"
        class="btn btn-primary btn-circle w-36 h-36"
        aria-label="Record"
        @click="recorder.start"
      >
        <span class="block w-12 h-12 rounded-full bg-error" />
      </button>
      <button
        v-else-if="state === 'recording'"
        class="btn btn-circle w-36 h-36 bg-warning border-warning hover:bg-warning/80"
        aria-label="Pause"
        @click="recorder.pause"
      >
        <PauseIcon class="w-16 h-16 text-warning-content" />
      </button>
      <button
        v-else
        class="btn btn-primary btn-circle w-36 h-36"
        aria-label="Resume recording"
        :disabled="isReviewPlaying"
        @click="recorder.resume"
      >
        <span class="block w-12 h-12 rounded-full bg-error" />
      </button>
    </div>

    <p v-if="state === 'paused' && punchInWarning > 0.05" class="text-warning text-sm text-center">
      ⚠ Recording from {{ formatDuration(reviewPosition) }} will replace
      {{ formatDuration(punchInWarning) }} of existing audio
    </p>

    <div v-if="state === 'paused' && reviewPosition >= elapsedTotal - 0.05" class="flex items-center justify-between gap-2">
      <span v-if="!noiseRegion" class="text-xs text-base-content/60">
        Tip: hit record for 5s of silence here to sample room ambience.
      </span>
      <span v-else class="flex-1" />
      <button class="btn btn-xs" @click="recorder.recordAmbientNoise">
        {{ ambienceManuallySet ? 'Re-record ambient' : 'Record ambient noise' }}
      </button>
    </div>

    <input
      v-if="state === 'paused'"
      v-model="saveTitle"
      type="text"
      placeholder="Name this recording (optional)"
      class="input input-bordered w-full"
    >

    <button
      v-if="hasContent"
      class="btn btn-outline w-full"
      :disabled="saving"
      @click="openSaveSheet"
    >
      <span v-if="saving" class="loading loading-spinner loading-sm" />
      {{ saving ? 'Saving…' : 'Save' }}
    </button>

    <!-- Cancel confirmation -->
    <dialog class="modal" :open="showCancelConfirm">
      <div class="modal-box">
        <h3 class="font-bold text-lg">Discard recording?</h3>
        <p class="py-2 text-base-content/70">
          Discard {{ formatDuration(elapsedTotal) }} of recording? This can't be undone.
        </p>
        <div class="modal-action">
          <button class="btn" @click="showCancelConfirm = false">Keep recording</button>
          <button class="btn btn-error" @click="confirmCancel">Discard</button>
        </div>
      </div>
    </dialog>

    <!-- Save sheet -->
    <dialog class="modal" :open="showSaveSheet">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-3">Save recording</h3>
        <label class="label" for="save-title">Name</label>
        <input
          id="save-title"
          v-model="saveTitle"
          type="text"
          class="input input-bordered w-full mb-3"
          placeholder="e.g. Nocturne in E flat"
          required
        >
        <label class="label">Tags (optional)</label>
        <TagPicker ref="tagPicker" v-model="saveTags" />
        <p v-if="saveError" class="alert alert-error text-sm mt-3">{{ saveError }}</p>
        <div class="modal-action">
          <button class="btn" :disabled="saving" @click="showSaveSheet = false">Back</button>
          <button class="btn btn-primary" :disabled="saving || !saveTitle.trim()" @click="confirmSave">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </dialog>
  </div>
</template>

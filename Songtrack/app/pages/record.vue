<script setup lang="ts">
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
  punchInWarning,
  recoverableSessionId,
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

async function openSaveSheet() {
  if (state.value === 'recording') await recorder.pause()
  showSaveSheet.value = true
}

async function confirmSave() {
  if (!saveTitle.value.trim()) return
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

function onScrub(e: Event) {
  const value = Number((e.target as HTMLInputElement).value)
  recorder.seekReview(value)
}

const hasContent = computed(() => state.value !== 'idle' || takes.value.length > 0)
</script>

<template>
  <div class="max-w-md mx-auto p-4 flex flex-col gap-4 min-h-[calc(100vh-4rem)]">
    <div class="flex items-center justify-between">
      <button class="btn btn-ghost btn-sm btn-circle" aria-label="Cancel" @click="requestCancel">
        ✕
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

    <div class="h-20 bg-base-300 rounded-box overflow-hidden">
      <WaveformCanvas
        v-if="state === 'paused'"
        :buckets="reviewWaveform"
        :progress="elapsedTotal > 0 ? reviewPosition / elapsedTotal : 0"
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
        class="range range-sm"
        min="0"
        :max="elapsedTotal"
        step="0.05"
        :value="reviewPosition"
        @input="onScrub"
      >
      <div class="flex items-center justify-between">
        <button class="btn btn-sm btn-circle" @click="isReviewPlaying ? recorder.pauseReview() : recorder.playReview()">
          {{ isReviewPlaying ? '⏸' : '▶' }}
        </button>
        <button
          v-if="reviewPosition < elapsedTotal - 0.05"
          class="btn btn-sm"
          @click="recorder.seekToEnd"
        >
          Seek to end
        </button>
      </div>
    </div>

    <div class="flex-1" />

    <div class="flex flex-col items-center gap-3">
      <button
        v-if="state === 'idle'"
        class="btn btn-primary btn-circle w-20 h-20 text-lg"
        @click="recorder.start"
      >
        ● Rec
      </button>
      <button
        v-else-if="state === 'recording'"
        class="btn btn-warning btn-circle w-20 h-20 text-lg"
        @click="recorder.pause"
      >
        ⏸ Pause
      </button>
      <button
        v-else
        class="btn btn-primary btn-circle w-20 h-20 text-lg"
        :disabled="isReviewPlaying"
        @click="recorder.resume"
      >
        ● Resume
      </button>

      <p v-if="state === 'paused' && punchInWarning > 0.05" class="text-warning text-sm text-center">
        ⚠ Recording from {{ formatDuration(reviewPosition) }} will replace
        {{ formatDuration(punchInWarning) }} of existing audio
      </p>

      <button
        v-if="hasContent"
        class="btn btn-outline w-full"
        @click="openSaveSheet"
      >
        Save
      </button>
    </div>

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
        <TagPicker v-model="saveTags" />
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

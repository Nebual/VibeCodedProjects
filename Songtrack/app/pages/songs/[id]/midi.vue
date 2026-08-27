<script setup lang="ts">
import { unzipSync } from 'fflate'
import type { BeatGrid, TranscribedNote, TranscriptionEvent, TranscriptionSummary } from '#shared/types'
import { DEFAULT_SUBDIVISION } from '#shared/types'

/**
 * Song-scoped, not a standalone uploader: `POST /api/songs/upload` already accepts
 * mp3/ogg/wav/flac/m4a and creates a song, so "transcribe an external file" is "upload it, then
 * transcribe it" — which reuses the whole existing ownership, storage and auth path instead of
 * building a second one.
 *
 * Note the routing trap this file avoids: it lives at `songs/[id]/midi.vue` under the existing
 * `[id]/` directory. A sibling `[id].vue` would become an implicit parent for everything under
 * `[id]/` and silently render itself instead of the child route.
 */
const route = useRoute()
const songId = route.params.id as string

const { data: song } = await useFetch<{ id: string, title: string, durationS: number | null }>(
  `/api/songs/${songId}`,
)
const { data: instrumentList } = await useFetch<{ instruments: string[] }>('/api/midi/instruments', {
  default: () => ({ instruments: [] }),
})
const { data: existing } = await useFetch<TranscriptionSummary | null>(
  `/api/songs/${songId}/transcription`,
)

const selected = ref<string[]>([])
function toggleInstrument(name: string) {
  const i = selected.value.indexOf(name)
  if (i === -1) selected.value.push(name)
  else selected.value.splice(i, 1)
}

// --- transcription state ---
const running = ref(false)
const done = ref(false)
/**
 * Whether the instrument chips and Start button are showing. Kept separate from `done` so a song
 * that already has a transcription can still be re-run against a different instrument selection —
 * which is a different cache key, and so a real second run rather than a cache hit.
 */
const showSetup = ref(true)
const errorMessage = ref<string | null>(null)
const completed = ref(0)
const total = ref(0)
const liveNotes = ref<TranscribedNote[]>([])
const finalNotes = ref<TranscribedNote[]>([])
const midiBytes = ref<ArrayBuffer | null>(null)
const grid = ref<BeatGrid | null>(null)
const hasDetectedGrid = ref(false)

const progressPct = computed(() => (total.value ? Math.round((completed.value / total.value) * 100) : 0))

/** The live roll while transcribing; the authoritative one once the run finishes. */
const rollNotes = computed(() => (done.value ? finalNotes.value : liveNotes.value))

/**
 * A stable id per browser tab. Upstream cancels a *same-client* resubmit at the next chunk
 * boundary, which is what makes hitting Start twice do the right thing — and it deliberately
 * cannot preempt another browser's run.
 */
const clientId = useState('midi-client-id', () => Math.random().toString(36).slice(2))

const pendingStarts = new Map<number, { pitch: number, start: number, instrument: string }>()

function handleEvent(ev: TranscriptionEvent) {
  switch (ev.type) {
    case 'progress':
      completed.value = ev.completed
      total.value = ev.total
      break
    case 'start':
      pendingStarts.set(ev.index, { pitch: ev.pitch, start: ev.start_time, instrument: ev.instrument })
      break
    case 'end': {
      const started = pendingStarts.get(ev.start_event_index)
      if (!started) break
      pendingStarts.delete(ev.start_event_index)
      liveNotes.value = [...liveNotes.value, { ...started, end: ev.end_time }]
      break
    }
    case 'transcription_complete':
      midiBytes.value = base64ToBytes(ev.data)
      break
    case 'error':
      errorMessage.value = ev.message
      break
  }
}

function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function start() {
  running.value = true
  done.value = false
  errorMessage.value = null
  completed.value = 0
  total.value = 0
  liveNotes.value = []
  finalNotes.value = []
  pendingStarts.clear()

  try {
    const res = await fetch(`/api/songs/${songId}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId.value },
      body: JSON.stringify({ instruments: selected.value }),
    })
    if (!res.ok || !res.body) {
      throw new Error((await res.text().catch(() => '')) || `Transcription failed (${res.status})`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done: streamDone, value } = await reader.read()
      if (streamDone) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        try {
          handleEvent(JSON.parse(line.slice(5).trim()) as TranscriptionEvent)
        }
        catch { /* a malformed frame isn't worth tearing the run down for */ }
      }
    }

    if (!errorMessage.value) await finish()
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : 'Transcription failed'
  }
  finally {
    running.value = false
  }
}

/**
 * The finished roll is drawn from the saved events, never from the streamed ones: the streamed
 * times run up to ~25 ms late and the saved ones don't, and a cache hit has no stream to replay
 * at all. One path for both, and the lag correction stays in exactly one place.
 */
async function finish() {
  const data = await $fetch<{ notes: TranscribedNote[], beatGrid: BeatGrid | null }>(
    `/api/songs/${songId}/transcription/events`,
  )
  finalNotes.value = data.notes
  hasDetectedGrid.value = !!data.beatGrid
  grid.value = data.beatGrid ?? {
    bpm: 120, beatsPerBar: 4, firstDownbeat: 0, onsetDelay: 0, subdivision: DEFAULT_SUBDIVISION,
  }
  done.value = true
  showSetup.value = false
}

// A song transcribed in an earlier visit goes straight to the results.
onMounted(() => { if (existing.value) finish() })

function transcribeAgain() {
  showSetup.value = true
  done.value = false
  completed.value = 0
  total.value = 0
}

// --- tempo editing ---
const pickingDownbeat = ref(false)
function onRollSeek(time: number) {
  if (!pickingDownbeat.value || !grid.value) return
  grid.value = { ...grid.value, firstDownbeat: Math.max(0, time) }
  pickingDownbeat.value = false
}

const gridQuery = computed(() => {
  const g = grid.value
  if (!g) return ''
  return `?bpm=${g.bpm}&beatsPerBar=${g.beatsPerBar}&firstDownbeat=${g.firstDownbeat}&subdivision=${g.subdivision}`
})

// --- engraving ---
interface SheetFile { name: string, url: string }
const sheets = ref<SheetFile[]>([])
const engraving = ref(false)
const engraveError = ref<string | null>(null)
const scorePdf = computed(() => sheets.value.find(f => f.name.endsWith('full_score.pdf'))?.url ?? null)

async function engrave() {
  engraving.value = true
  engraveError.value = null
  for (const f of sheets.value) URL.revokeObjectURL(f.url)
  sheets.value = []
  try {
    const res = await fetch(`/api/songs/${songId}/transcription/sheets${gridQuery.value}`)
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Engraving failed (${res.status})`)
    // One round trip, unzipped in the browser — MuseScore is slow and the archive holds the
    // full score, one PDF per instrument, the MusicXML and the score MIDI all at once.
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
    sheets.value = Object.entries(files).map(([name, bytes]) => ({
      name,
      url: URL.createObjectURL(new Blob([bytes as Uint8Array], { type: mimeFor(name) })),
    }))
  }
  catch (e) {
    engraveError.value = e instanceof Error ? e.message : 'Engraving failed'
  }
  finally {
    engraving.value = false
  }
}

function mimeFor(name: string): string {
  if (name.endsWith('.pdf')) return 'application/pdf'
  if (name.endsWith('.mid')) return 'audio/midi'
  if (name.endsWith('.musicxml')) return 'application/vnd.recordare.musicxml+xml'
  return 'application/octet-stream'
}

onScopeDispose(() => { for (const f of sheets.value) URL.revokeObjectURL(f.url) })
</script>

<template>
  <div v-if="song" class="max-w-3xl mx-auto p-4 flex flex-col gap-4">
    <div class="flex items-center gap-3">
      <NuxtLink :to="`/songs/${songId}`" class="btn btn-sm btn-ghost">← Back</NuxtLink>
      <h1 class="text-xl font-semibold flex-1">Transcribe “{{ song.title }}”</h1>
    </div>

    <!-- setup -->
    <div v-if="showSetup" class="flex flex-col gap-3">
      <div>
        <p class="label-text text-xs mb-1">
          Instruments — leave all off to let the model detect them.
        </p>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="name in instrumentList.instruments"
            :key="name"
            class="btn btn-xs"
            :class="selected.includes(name) ? 'btn-primary' : 'btn-outline'"
            :disabled="running"
            @click="toggleInstrument(name)"
          >
            {{ name.replace(/_/g, ' ') }}
          </button>
        </div>
      </div>

      <button
        class="btn btn-primary btn-sm self-start"
        :disabled="running"
        data-testid="start-transcription"
        @click="start"
      >
        {{ running ? 'Transcribing…' : 'Start transcription' }}
      </button>

    </div>

    <!-- Outside the setup block on purpose: that block unmounts the moment the run completes, so
         a progress bar inside it would vanish rather than ever being seen to reach 100%. -->
    <div v-if="total > 0" class="flex items-center gap-2">
      <progress
        class="progress progress-primary flex-1"
        :value="completed" :max="total || 1"
        data-testid="transcribe-progress"
      />
      <span class="text-xs tabular-nums w-12 text-right" data-testid="progress-pct">{{ progressPct }}%</span>
    </div>

    <div v-if="errorMessage" class="alert alert-error text-sm" data-testid="transcribe-error">
      {{ errorMessage }}
    </div>

    <!-- piano roll: live while running, redrawn from the saved events when finished -->
    <div v-if="rollNotes.length || running" class="h-56">
      <PianoRoll :notes="rollNotes" :grid="done ? grid : null" :duration="song.durationS ?? undefined" @seek="onRollSeek" />
    </div>

    <template v-if="done && grid">
      <p v-if="!hasDetectedGrid" class="alert alert-warning text-sm">
        No tempo was detected for this recording, so the notation will be rough until you set one
        below. Playback is unaffected either way.
      </p>

      <div class="flex justify-end">
        <button class="btn btn-xs btn-ghost" data-testid="transcribe-again" @click="transcribeAgain">
          Transcribe again with different instruments
        </button>
      </div>

      <MidiTempoEditor v-model="grid" :notes="finalNotes" :picking-downbeat="pickingDownbeat" @pick-downbeat="pickingDownbeat = true" />

      <MidiCrossfadePlayer :song-id="songId" :midi="midiBytes" />

      <div class="flex flex-col gap-2 p-3 rounded-box bg-base-200">
        <h3 class="font-semibold text-sm">Downloads</h3>
        <div class="flex flex-wrap items-center gap-2">
          <!-- Emphasis on Score MIDI: notation is what people are usually after, and handing
               them the performance file to import is how this feature disappoints. -->
          <a
            class="btn btn-sm btn-primary"
            :href="`/api/songs/${songId}/transcription/midi${gridQuery}&variant=score`"
            data-testid="download-score-midi"
          >Score MIDI</a>
          <a
            class="btn btn-sm btn-outline"
            :href="`/api/songs/${songId}/transcription/midi?variant=performance`"
            data-testid="download-performance-midi"
          >Performance MIDI</a>
          <a
            class="btn btn-sm btn-ghost"
            :href="`/api/songs/${songId}/transcription/preview?mode=mix`"
          >Check mix (ogg)</a>
        </div>
        <ul class="text-xs text-base-content/60 list-disc pl-4">
          <li><strong>Score MIDI</strong> — snapped to the beat. Use this one for MuseScore, Sibelius or any notation software.</li>
          <li><strong>Performance MIDI</strong> — sounds like the recording. Best for listening or importing into a DAW.</li>
        </ul>
      </div>

      <div class="flex flex-col gap-2 p-3 rounded-box bg-base-200">
        <div class="flex items-center gap-2">
          <h3 class="font-semibold text-sm flex-1">Sheet music</h3>
          <button class="btn btn-sm btn-primary" :disabled="engraving" data-testid="engrave" @click="engrave">
            {{ engraving ? 'Engraving…' : 'Engrave' }}
          </button>
        </div>
        <p class="text-xs text-base-content/60">
          Engraving runs MuseScore and takes a few seconds — check the barlines on the roll above
          first. Expect a good starting point to edit, not a finished score.
        </p>
        <div v-if="engraveError" class="alert alert-error text-sm" data-testid="engrave-error">{{ engraveError }}</div>
        <!-- <object>, not <embed>: it supports fallback content, so a browser with no PDF viewer
             gets a link instead of a blank panel saying "couldn't load plugin". -->
        <object v-if="scorePdf" :data="scorePdf" type="application/pdf" class="w-full h-96 rounded">
          <a :href="scorePdf" download="full_score.pdf" class="btn btn-sm btn-outline">
            Open the full score PDF
          </a>
        </object>
        <div v-if="sheets.length" class="flex flex-wrap gap-2">
          <a v-for="f in sheets" :key="f.name" :href="f.url" :download="f.name" class="btn btn-xs btn-outline">{{ f.name }}</a>
        </div>
      </div>
    </template>
  </div>
</template>

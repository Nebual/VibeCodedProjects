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
const grid = ref<BeatGrid | null>(null)

const ZOOM_CHOICES = [
  { seconds: 5, label: '5s' },
  { seconds: 10, label: '10s' },
  { seconds: 30, label: '30s' },
  { seconds: 0, label: 'All' },
]
/** Ten seconds at a time by default — a whole song squeezed across one canvas is unreadable. */
const zoom = ref(10)
const rollWindow = computed(() => (zoom.value > 0 ? zoom.value : null))
const playhead = ref(0)
const mutedInstruments = ref<string[]>([])
const playerRef = useTemplateRef<{ seek: (s: number) => void, stop: () => void }>('player')

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
      // Nothing to keep here any more: the player is driven by notes, and the finished ones are
      // fetched from the server in finish(). Holding the MIDI bytes was how the player ended up
      // silent on every revisit — they only ever arrived on the run that streamed them.
      break
    case 'error':
      errorMessage.value = ev.message
      break
  }
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
      // Always force from this page: the user pressed a button, so something must happen —
      // an unchanged instrument selection would otherwise be an instant, invisible no-op.
      body: JSON.stringify({ instruments: selected.value, force: true }),
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
  // The server now always supplies its best grid — detected, or estimated from the onsets when
  // the beat tracker refused to commit — so a bare 120 placeholder is only ever the last resort.
  grid.value = data.beatGrid ?? {
    bpm: 120, beatsPerBar: 4, firstDownbeat: 0, onsetDelay: 0, subdivision: DEFAULT_SUBDIVISION,
    source: 'estimated',
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
  if (pickingDownbeat.value && grid.value) {
    // Snapped to the nearest beat, keeping the grid's phase. A sub-beat downbeat slides the
    // barlines between the notes instead of moving with them, which syncopates the whole piece
    // and fills the score with ties — see snapDownbeat() server-side for the full reasoning.
    const g = grid.value
    const beat = 60 / g.bpm
    const moved = g.firstDownbeat + Math.round((time - g.firstDownbeat) / beat) * beat
    let snapped = moved
    while (snapped < -1e-9) snapped += beat
    grid.value = {
      ...g,
      firstDownbeat: Math.max(0, Math.round(snapped * 10000) / 10000),
      source: 'user',
    }
    pickingDownbeat.value = false
    return
  }
  // Otherwise a click on the roll is a playback position, which is what people expect of it.
  playhead.value = Math.max(0, time)
  playerRef.value?.seek(playhead.value)
}

const gridQuery = computed(() => {
  const g = grid.value
  if (!g) return ''
  return `?bpm=${g.bpm}&beatsPerBar=${g.beatsPerBar}&firstDownbeat=${g.firstDownbeat}&subdivision=${g.subdivision}`
})

/**
 * The synth render is a real round trip: the sidecar renders it and ffmpeg re-encodes it, which
 * takes seconds. A plain <a download> gives no feedback at all, so it's fetched here instead and
 * handed to the browser as a blob once it has actually arrived.
 */
const downloadingSynth = ref(false)
const synthError = ref<string | null>(null)

async function downloadSynth() {
  downloadingSynth.value = true
  synthError.value = null
  try {
    const res = await fetch(`/api/songs/${songId}/transcription/preview?mode=synth`)
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Render failed (${res.status})`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${song.value?.title ?? 'transcription'}-synth.ogg`
    a.click()
    // Revoked on the next tick: revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  catch (e) {
    synthError.value = e instanceof Error ? e.message : 'Could not render the synth audio'
  }
  finally {
    downloadingSynth.value = false
  }
}

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
  // MuseScore's own format, added by patches/0001-mscz-export-and-tempo-hint.patch.
  if (name.endsWith('.mscz')) return 'application/vnd.musescore.mscz+zip'
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
          Instruments — leave this empty to let the model detect them.
        </p>
        <InstrumentPicker
          v-model="selected"
          :options="instrumentList.instruments"
          :disabled="running"
        />
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
      <span>{{ errorMessage }}</span>
    </div>

    <!-- piano roll: live while running, redrawn from the saved events when finished -->
    <template v-if="rollNotes.length || running">
      <div class="flex items-center gap-2">
        <span class="text-xs text-base-content/60">Show</span>
        <div class="join">
          <button
            v-for="z in ZOOM_CHOICES"
            :key="z.label"
            class="btn btn-xs join-item"
            :class="zoom === z.seconds ? 'btn-primary' : 'btn-outline'"
            :data-testid="`zoom-${z.label}`"
            @click="zoom = z.seconds"
          >{{ z.label }}</button>
        </div>
        <span class="text-xs text-base-content/50 ml-auto">
          Click the roll to move playback{{ pickingDownbeat ? ' — or to set the downbeat' : '' }}.
        </span>
      </div>
      <div class="h-56">
        <PianoRoll
          :notes="rollNotes"
          :grid="done ? grid : null"
          :duration="song.durationS ?? undefined"
          :window="rollWindow"
          :playhead="playhead"
          :follow="true"
          :muted="mutedInstruments"
          @seek="onRollSeek"
        />
      </div>

      <!-- Available while transcribing too: the whole point is hearing it before it finishes. -->
      <MidiCrossfadePlayer
        ref="player"
        :song-id="songId"
        :notes="rollNotes"
        :duration="song.durationS ?? undefined"
        :live="running"
        @time="playhead = $event"
        @update:muted="mutedInstruments = $event"
      />
    </template>

    <template v-if="done && grid">
      <!-- One <span> child, not loose text: daisyUI's .alert is a grid, so bare text nodes and the
           <strong> each become their own grid item and the sentence breaks apart. -->
      <div v-if="grid.source === 'estimated'" class="alert alert-warning text-sm">
        <span>
          The beat tracker wouldn't commit to a tempo for this recording, so
          <strong>{{ grid.bpm }} BPM is an estimate</strong> — close enough to start from, not to
          trust. Check the barlines on the roll, and try ×2 or ÷2 if every other one lands in empty
          space. Playback is unaffected either way.
        </span>
      </div>

      <div class="flex justify-end">
        <button class="btn btn-xs btn-ghost" data-testid="transcribe-again" @click="transcribeAgain">
          Transcribe again
        </button>
      </div>

      <MidiTempoEditor v-model="grid" :notes="finalNotes" :picking-downbeat="pickingDownbeat" @pick-downbeat="pickingDownbeat = true" />

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
          <button
            class="btn btn-sm btn-ghost"
            :disabled="downloadingSynth"
            data-testid="download-synth"
            @click="downloadSynth"
          >
            <span v-if="downloadingSynth" class="loading loading-spinner loading-xs" />
            {{ downloadingSynth ? 'Rendering…' : 'Download synth (ogg)' }}
          </button>
        </div>
        <div v-if="synthError" class="alert alert-error text-sm" data-testid="synth-download-error">
          <span>{{ synthError }}</span>
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
        <div v-if="engraveError" class="alert alert-error text-sm" data-testid="engrave-error">
          <span>{{ engraveError }}</span>
        </div>
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

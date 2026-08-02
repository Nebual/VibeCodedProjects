<script setup lang="ts">
import type { JobInfo } from '~/types/api'

const props = defineProps<{
  bookId: string
  model: string
  voice: string
  speed: number
  /** Per-request model tuning, already reduced to non-default knobs. */
  options: Record<string, number>
  includedChapters: number
}>()

const job = ref<JobInfo | null>(null)
const starting = ref(false)
const error = ref<string | null>(null)
const format = ref<'mp3' | 'm4b' | 'both'>('m4b')
let source: EventSource | null = null

/** Latest job for this book, so a reload mid-render picks the stream back up. */
const { data: existing } = await useFetch<JobInfo[]>(`/api/books/${props.bookId}/jobs`, {
  default: () => [],
})
if (existing.value.length) job.value = existing.value[0]!

function listen(id: string) {
  close()
  source = new EventSource(`/api/jobs/${id}/events`)
  source.onmessage = (event) => {
    job.value = JSON.parse(event.data) as JobInfo
  }
  // The server closes the stream once the job is terminal. Without this the
  // browser would reconnect forever to a finished job.
  source.addEventListener('end', () => close())
  source.onerror = () => close()
}

function close() {
  source?.close()
  source = null
}

onBeforeUnmount(close)

// Reconnect when a render is already running (page reload, navigation back).
watchEffect(() => {
  const current = job.value
  if (current && !current.is_terminal && !source) listen(current.id)
})

async function start() {
  starting.value = true
  error.value = null
  try {
    job.value = await $fetch<JobInfo>(`/api/books/${props.bookId}/render`, {
      method: 'POST',
      body: {
        voice: props.voice,
        speed: props.speed,
        model: props.model,
        options: props.options,
        output_format: format.value,
      },
    })
    listen(job.value.id)
  }
  catch (e: unknown) {
    const err = e as { data?: { detail?: string } }
    error.value = err.data?.detail ?? 'Could not start the render.'
  }
  finally {
    starting.value = false
  }
}

async function cancel() {
  if (!job.value) return
  job.value = await $fetch<JobInfo>(`/api/jobs/${job.value.id}/cancel`, { method: 'POST' })
}

const STATUS_BADGE: Record<string, string> = {
  queued: 'badge-ghost',
  running: 'badge-info',
  cancelling: 'badge-warning',
  cancelled: 'badge-ghost',
  done: 'badge-success',
  failed: 'badge-error',
}

const percent = computed(() => Math.round((job.value?.progress ?? 0) * 100))

function tuningLabel(options: Record<string, number>): string {
  return Object.entries(options)
    .map(([id, value]) => `${id} ${value}`)
    .join(', ')
}

/** Remaining time from observed throughput, not a fixed guess. */
const eta = computed(() => {
  const j = job.value
  if (!j || j.is_terminal || !j.started_at || j.chunks_done < 5) return null
  const elapsed = (Date.now() - new Date(j.started_at).getTime()) / 1000
  const rate = j.chunks_done / elapsed
  if (rate <= 0) return null
  return duration((j.chunks_total - j.chunks_done) / rate)
})
</script>

<template>
  <section class="card bg-base-100 shadow-sm">
    <div class="card-body gap-4">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 class="card-title text-base">
            Render
          </h2>
          <p class="text-base-content/50 text-xs">
            {{ includedChapters }} chapter{{ includedChapters === 1 ? '' : 's' }} selected.
            Audio is cached, so a cancelled render resumes where it stopped.
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <select
            v-if="!job || job.is_terminal"
            v-model="format"
            class="select select-bordered select-sm"
            aria-label="Output format"
          >
            <option value="m4b">
              M4B — one file, chapter marks
            </option>
            <option value="mp3">
              MP3 — one file per chapter
            </option>
            <option value="both">
              Both
            </option>
          </select>

          <span v-if="job" class="badge badge-ghost badge-sm">{{ job.model }}</span>
          <!-- Two renders of one book can now differ by settings alone, so the
               job has to say which it used. -->
          <span
            v-if="job && Object.keys(job.options ?? {}).length"
            class="badge badge-ghost badge-sm"
            :title="tuningLabel(job.options)"
          >
            tuned
          </span>
          <span v-if="job" class="badge badge-sm" :class="STATUS_BADGE[job.status]">
            {{ job.stage && !job.is_terminal ? job.stage : job.status }}
          </span>

          <a
            v-if="job && job.status === 'done' && job.artifact_path"
            class="btn btn-sm btn-success"
            :href="`/api/jobs/${job.id}/download`"
          >
            Download{{ job.artifact_bytes ? ` (${megabytes(job.artifact_bytes)})` : '' }}
          </a>
          <button
            v-if="job && !job.is_terminal"
            class="btn btn-sm btn-outline btn-error"
            @click="cancel"
          >
            Cancel
          </button>
          <button
            v-else
            class="btn btn-sm btn-primary"
            :disabled="starting || includedChapters === 0"
            @click="start"
          >
            <span v-if="starting" class="loading loading-spinner loading-xs" />
            {{ job ? 'Render again' : 'Start render' }}
          </button>
        </div>
      </div>

      <div v-if="error" class="alert alert-error text-sm">
        <span>{{ error }}</span>
      </div>

      <template v-if="job">
        <div v-if="!job.is_terminal || job.chunks_done > 0" class="space-y-1">
          <progress class="progress progress-primary w-full" :value="percent" max="100" />
          <div class="text-base-content/60 flex flex-wrap justify-between gap-2 text-xs">
            <span>
              {{ job.chunks_done.toLocaleString() }} / {{ job.chunks_total.toLocaleString() }}
              chunks · {{ percent }}%
              <span v-if="job.cache_hits > 0">
                · {{ job.cache_hits.toLocaleString() }} from cache
              </span>
            </span>
            <span>
              <template v-if="job.current_title">{{ job.current_title }} · </template>
              {{ duration(job.audio_seconds) }} of audio
              <template v-if="eta"> · ~{{ eta }} left</template>
            </span>
          </div>
        </div>

        <div v-if="job.error" class="alert alert-error text-sm">
          <span>{{ job.error }}</span>
        </div>

        <ul class="divide-base-200 divide-y text-sm">
          <li
            v-for="chapter in job.chapters"
            :key="chapter.chapter_index"
            class="flex items-center gap-3 py-1.5"
          >
            <span
              class="w-16 shrink-0 text-xs"
              :class="{
                'text-success': chapter.status === 'done',
                'text-info': chapter.status === 'running',
                'text-error': chapter.status === 'failed',
                'text-base-content/40': chapter.status === 'pending',
              }"
            >{{ chapter.status }}</span>

            <span class="min-w-0 flex-1 truncate">{{ chapter.title }}</span>

            <span class="text-base-content/40 shrink-0 text-xs">
              <template v-if="chapter.chunks_total">
                {{ chapter.chunks_done }}/{{ chapter.chunks_total }}
              </template>
            </span>
            <span class="text-base-content/50 w-20 shrink-0 text-right text-xs">
              {{ chapter.audio_seconds ? duration(chapter.audio_seconds) : '—' }}
            </span>

            <audio
              v-if="chapter.has_audio"
              controls
              preload="none"
              class="h-8 w-44 shrink-0"
              :src="`/api/jobs/${job.id}/chapters/${chapter.chapter_index}/audio`"
            />
          </li>
        </ul>
      </template>
    </div>
  </section>
</template>

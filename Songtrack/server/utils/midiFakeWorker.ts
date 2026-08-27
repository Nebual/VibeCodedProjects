import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The one escape hatch in `midiWorker.ts`, modelled on `ALLOW_TEST_LOGIN` in
 * `server/api/_test-login.get.ts`: Playwright cannot run a 6 GB torch container, so when
 * `MIDI_FAKE_WORKER=true` a canned event stream stands in for the sidecar.
 *
 * Set it only in `playwright.config.ts`'s `webServer.env`. The frames it replays are
 * byte-shape-identical to the real sidecar's — if they ever drift, the e2e suite tests nothing.
 */

const FIXTURE = 'tests/e2e/fixtures/transcribe-stream.jsonl'

/** Slow enough that the progress bar and the piano roll actually animate; fast enough for CI. */
const FRAME_DELAY_MS = 40

/**
 * The real MT3 taxonomy, captured verbatim from a live sidecar's `GET /instruments`. Using the
 * actual names matters: the e2e suite clicks these chips by label, so an invented name would let
 * a test pass against a stub that the real worker would reject.
 */
export function fakeInstruments(): string[] {
  return [
    'acoustic_piano',
    'electric_piano',
    'chromatic_percussion',
    'organ',
    'acoustic_guitar',
    'clean_electric_guitar',
    'distorted_electric_guitar',
    'acoustic_bass',
    'electric_bass',
    'violin',
    'viola',
    'cello',
    'contrabass',
    'orchestral_harp',
    'timpani',
    'string_ensemble',
    'synth_strings',
    'voice',
    'orchestra_hit',
    'trumpet',
    'trombone',
    'tuba',
    'french_horn',
    'brass_section',
    'soprano_and_alto_sax',
    'tenor_sax',
    'baritone_sax',
    'oboe',
    'english_horn',
    'bassoon',
    'clarinet',
    'flutes',
    'synth_lead',
    'synth_pad',
    'drums',
  ]
}

function fixtureFrames(): string[] {
  const raw = readFileSync(join(process.cwd(), FIXTURE), 'utf8')
  return raw.split('\n').filter(Boolean)
}

/**
 * A `Response` shaped exactly like the sidecar's `/transcribe`: `text/event-stream`, one JSON
 * object per `data:` line, `X-Accel-Buffering: no`.
 */
export function fakeTranscribeResponse(signal?: AbortSignal): Response {
  const frames = fixtureFrames()
  const encoder = new TextEncoder()
  let i = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        clearTimeout(timer)
        try {
          controller.close()
        }
        catch { /* already closed */ }
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const pump = () => {
        if (signal?.aborted) return
        if (i >= frames.length) {
          signal?.removeEventListener('abort', onAbort)
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(`data: ${frames[i]}\n\n`))
        i++
        timer = setTimeout(pump, FRAME_DELAY_MS)
      }
      pump()
    },
    cancel() {
      clearTimeout(timer)
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}

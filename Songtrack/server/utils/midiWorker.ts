import { readFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fakeInstruments, fakeTranscribeResponse } from './midiFakeWorker'

/**
 * The only module that knows a transcription sidecar exists. Everything above this speaks
 * Songtrack's own vocabulary; everything below it is upstream MuScriptor's HTTP API.
 *
 * The sidecar has no authentication of its own and is never published to a host port — see
 * docker-compose.yml. Reaching it is the Nuxt server's privilege alone.
 */

/**
 * Silence prepended to the audio before the model sees it.
 *
 * The model reliably misses a note that lands right at the very start of a file — measured on a
 * clean 8-note scale beginning at t=0, it returned 7 notes and dropped the first every time.
 * Giving it a fraction of a second of lead-in recovers it: 0.1s was already enough, and every
 * padded run returned all 8 with the onsets simply offset by the pad. 0.2s is that with margin.
 *
 * Everything the sidecar reports is therefore `padSeconds` late, and the transcribe route shifts
 * it all back so nothing downstream — the roll, the events, the stored MIDI, the beat grid — ever
 * sees the padding.
 */
export const TRANSCRIBE_PAD_S = 0.2

/** Which model the sidecar was launched with. Part of the spec hash, so bumping it re-transcribes. */
export function midiWorkerModel(): string {
  return process.env.MIDI_WORKER_MODEL || 'small'
}

/** True when the canned event stream stands in for a real sidecar (Playwright, local dev). */
export function usingFakeWorker(): boolean {
  return process.env.MIDI_FAKE_WORKER === 'true'
}

export function midiWorkerUrl(): string {
  const url = process.env.MIDI_WORKER_URL
  if (!url) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Transcription is not configured on this server '
        + '(MIDI_WORKER_URL is unset — see the Audio → MIDI section of README.md).',
    })
  }
  return url.replace(/\/+$/, '')
}

/** Upstream returns a readable body on error too; surface it instead of a bare status code. */
async function assertOk(res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  const detail = await res.text().catch(() => '')
  if (res.status === 503) {
    throw createError({
      statusCode: 503,
      statusMessage: `The transcription worker can't ${what} right now. `
        + `MuseScore may be missing from the sidecar image. ${detail}`.trim(),
    })
  }
  throw createError({
    statusCode: 502,
    statusMessage: `Transcription worker failed to ${what} (${res.status}). ${detail}`.trim(),
  })
}

async function fileBlob(path: string, type: string): Promise<Blob> {
  // A four-minute ogg is a few megabytes. Buffering it is fine and a streaming multipart
  // upload would be a lot of machinery for no measurable gain.
  const bytes = await readFile(path)
  return new Blob([new Uint8Array(bytes)], { type })
}

/**
 * Starts a transcription. Returns the raw `Response` so the caller can tee the SSE body
 * rather than having it buffered here.
 *
 * `clientId` lets upstream cancel a *same-client* resubmit at the next chunk boundary, which is
 * what makes hitting Start twice in one tab do the right thing. It deliberately cannot preempt
 * another browser's run.
 *
 * Sent as the `X-Client-Id` header, which is what upstream declares on both v0.3.0 and main
 * (`x_client_id: Annotated[str | None, Header()]`).
 */
export interface TranscribeStream {
  response: Response
  /** Seconds of silence prepended; subtract this from every time the sidecar reports. */
  padSeconds: number
}

export async function postAudio(
  path: string,
  opts: { instruments: string[], clientId: string, signal?: AbortSignal, tmpDir?: string },
): Promise<TranscribeStream> {
  // The stub replays fixed frames from a file, so there is nothing to pad and nothing to shift.
  if (usingFakeWorker()) return { response: fakeTranscribeResponse(opts.signal), padSeconds: 0 }

  const padded = opts.tmpDir ? await padAudio(path, opts.tmpDir) : null
  const form = new FormData()
  form.append('file', await fileBlob(padded ?? path, 'audio/flac'), basename(padded ?? path))
  // Repeated keys, not `instruments[]` — FastAPI collects a `List[str] = Form(...)` that way.
  // An empty list means auto-detect.
  for (const instrument of opts.instruments) form.append('instruments', instrument)
  form.append('detect_tempo', 'best-effort')

  try {
    const res = await fetch(`${midiWorkerUrl()}/transcribe`, {
      method: 'POST',
      body: form,
      headers: { 'X-Client-Id': opts.clientId, 'Accept': 'text/event-stream' },
      signal: opts.signal,
    })
    await assertOk(res, 'transcribe this song')
    return { response: res, padSeconds: padded ? TRANSCRIBE_PAD_S : 0 }
  }
  finally {
    // The body is already buffered into the form, so the file on disk has done its job.
    if (padded) await unlink(padded).catch(() => {})
  }
}

/**
 * Writes a copy of `path` with `TRANSCRIBE_PAD_S` of silence in front.
 *
 * FLAC, not another ogg: the pad needs a re-encode, and going lossless avoids a second generation
 * of lossy loss on the only copy the model ever hears. The sample rate and channel count are left
 * alone — the model resamples to 16 kHz mono itself, and doing that here would only introduce a
 * different resampler than the one it expects.
 */
async function padAudio(path: string, tmpDir: string): Promise<string | null> {
  const out = join(tmpDir, `padded-${Date.now()}.flac`)
  try {
    await runFfmpeg([
      '-y', '-i', path,
      '-af', `adelay=${Math.round(TRANSCRIBE_PAD_S * 1000)}:all=1`,
      '-c:a', 'flac', out,
    ])
    return out
  }
  catch {
    // Padding is a workaround, not a requirement: if ffmpeg can't do it, transcribe the original
    // and accept that a note starting at t=0 may go missing.
    return null
  }
}

/** The MT3 instrument-group taxonomy. Static for the life of the container, so cached below. */
let instrumentsCache: string[] | null = null

export async function getInstruments(): Promise<string[]> {
  if (instrumentsCache) return instrumentsCache
  if (usingFakeWorker()) {
    instrumentsCache = fakeInstruments()
    return instrumentsCache
  }
  const res = await assertOk(
    await fetch(`${midiWorkerUrl()}/instruments`),
    'list instruments',
  )
  const body = await res.json() as { instruments?: string[] }
  instrumentsCache = body.instruments ?? []
  return instrumentsCache
}

/**
 * Engraves a MIDI file. `quantized` tells MuseScore's importer the notes are already on a grid so
 * it doesn't layer its own quantization heuristics on top of ours — sending snapped MIDI with
 * `quantized=false` gives the worst of both. Returns a ZIP_STORED archive containing `score.mid`,
 * `score.musicxml`, `full_score.pdf`, one PDF per instrument, and tablature for guitar/bass parts.
 */
export async function postSheets(midi: Buffer, quantized: boolean): Promise<Buffer> {
  const form = new FormData()
  form.append('midi', new Blob([new Uint8Array(midi)], { type: 'audio/midi' }), 'score.mid')
  form.append('quantized', quantized ? 'true' : 'false')

  const res = await fetch(`${midiWorkerUrl()}/sheets`, { method: 'POST', body: form })

  // muscriptor 0.3.0 as built ships no /sheets route at all: its endpoints are /health,
  // /instruments, /soundfonts/…, /transcribe, /transcribe/midi and /auralize. An unknown path
  // falls through to the bundled SPA, which serves GET only — hence 405, not 404. Reporting that
  // as a generic 502 would send someone hunting for a network fault that isn't there.
  if (res.status === 404 || res.status === 405) {
    throw createError({
      statusCode: 501,
      statusMessage: 'This transcription worker cannot engrave sheet music — its build has no '
        + '/sheets endpoint. Download the Score MIDI and open it in MuseScore instead.',
    })
  }

  await assertOk(res, 'engrave this score')
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Renders the transcription as audio. `mix` puts the original recording left and the synthesised
 * transcription right, which is the check you actually want; `synth` gives the transcription alone.
 */
export async function postAuralize(
  midi: Buffer,
  audioPath: string | null,
  mode: 'mix' | 'synth',
): Promise<Buffer> {
  const form = new FormData()
  form.append('midi', new Blob([new Uint8Array(midi)], { type: 'audio/midi' }), 'performance.mid')
  if (audioPath) form.append('audio', await fileBlob(audioPath, 'audio/ogg'), basename(audioPath))
  form.append('mode', mode)

  const res = await fetch(`${midiWorkerUrl()}/auralize`, { method: 'POST', body: form })
  await assertSoundfontsPresent(res, 'render an audio preview')
  await assertOk(res, 'render an audio preview')
  return Buffer.from(await res.arrayBuffer())
}

/** The 38 MB SoundFont the in-browser synth plays through. Proxied, not CDN-hosted. */
export async function getSoundfont(): Promise<Response> {
  const res = await fetch(`${midiWorkerUrl()}/soundfonts/MuseScore_General.sf3`)
  // Unlike /auralize, this route answers a missing cache with a bare `Internal Server Error` and
  // no diagnostic body — but serving a static file it prewarmed has essentially no other way to
  // fail, so a 500 here is the cache every time.
  await assertSoundfontsPresent(res, 'serve the soundfont', true)
  return assertOk(res, 'serve the soundfont')
}

/**
 * Both `/auralize` and `/soundfonts/…` resolve their SoundFont through the HuggingFace hub cache,
 * and both 500 with a "cannot find the requested files in the local cache" body when it isn't
 * there. That happens for one specific, easy-to-make reason: the upstream image prewarms the
 * soundfonts into its *default* HF cache, so pointing `HF_HOME` at a volume that only holds the
 * model weights hides them, and `HF_HUB_OFFLINE=1` then forbids fetching them. Saying that
 * outright beats a bare 500.
 */
async function assertSoundfontsPresent(
  res: Response,
  what: string,
  anyServerError = false,
): Promise<void> {
  if (res.status !== 500) return
  if (!anyServerError) {
    const body = await res.clone().text().catch(() => '')
    if (!/local cache|locate the file on the Hub/i.test(body)) return
  }
  throw createError({
    statusCode: 503,
    statusMessage: `The transcription worker can't ${what}: its SoundFont isn't in the model `
      + 'cache. The sidecar\'s HF_HOME is pointed at a volume holding only the model weights, '
      + 'which hides the soundfonts baked into the image. See the Audio → MIDI section of README.md.',
  })
}

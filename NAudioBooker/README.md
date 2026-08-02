# NAudioBooker

Turn an EPUB into an audiobook: per-chapter MP3s with correct metadata, or a
single M4B with chapter markers.

See [PLAN.md](PLAN.md) for the architecture and phase breakdown.

**Status: Phase 4 complete.** Upload an EPUB, review how it was split into chapters, pick a
voice, render it with live progress, and download the result as tagged per-chapter MP3s or a
single M4B with chapter markers. Audio is loudness-normalised to the ACX window.

Every synthesized chunk is cached by content, so a cancelled or crashed render resumes where
it stopped, and re-rendering after excluding a chapter costs nothing for the chapters that
did not change.

## Requirements

- Node 24 + pnpm
- Python 3.12 (managed by [uv](https://docs.astral.sh/uv/))
- `ffmpeg` and `espeak-ng` on `PATH`

```bash
sudo apt install ffmpeg espeak-ng
```

## Setup

```bash
pnpm install
cd api && uv sync --extra dev && cd ..
```

## Run

```bash
pnpm dev          # api on :8000, worker, web on :3000
```

Or separately:

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

The worker is a separate process on purpose: a render runs for hours, and a
synthesis crash should not take the API down with it. The two coordinate only
through SQLite in WAL mode, so readers never block the writer and progress
stays live while a render is hammering the database.

Open <http://localhost:3000>. The home page reports backend health, including
whether `ffmpeg` and `espeak-ng` were found.

## Docker

```bash
docker compose up --build
```

## Layout

```
api/                  Python service (FastAPI)
  naudiobooker/
    config.py         Settings, NAB_-prefixed env vars
    main.py           App factory, /health
    models.py         Book and chapter API models
    schemas.py        Shared response models
    store.py          Filesystem-backed book storage
    epub/
      parser.py       container.xml, OPF, nav doc / NCX
      cleaner.py      XHTML -> narratable paragraphs
      chapters.py     Spine + TOC -> chapters
    db.py             SQLite (WAL) connections and job schema
    jobs.py           Render queue: enqueue, claim, progress, cancel
    cache.py          Content-addressed cache of synthesized chunks
    worker/runner.py  Drains the queue, renders chapter by chapter
    text/chunker.py   Chapter text -> synthesis chunks
    tts/
      base.py         TTSBackend protocol -- the seam for every engine
      kokoro_local.py Kokoro-82M via onnxruntime
      registry.py     Resolves the configured backend
    audio/encode.py   WAV encoding
    routes/           books.py, tts.py
  scripts/
    benchmark_tts.py  Measure real-time factor on your hardware
web/                  Nuxt 4 + Tailwind v4 + DaisyUI 5
  server/api/         Catch-all proxy to the Python service
  app/pages/          Library and chapter review screens
data/                 Uploads, extracted text, rendered audio (gitignored)
```

## How a book is parsed

The spine is authoritative for order and for what content exists; the table of
contents is authoritative for titles and chapter boundaries. Neither alone
suffices — TOCs omit real content, and spines have no titles. Chapters may span
several documents, or several chapters may share one document behind fragment
anchors; both cases are handled.

Front and back matter (cover, copyright, ad cards, newsletter sign-ups) is
excluded by default but can be re-enabled per chapter in the review screen.

The browser only ever talks to Nuxt. Everything under `/api/**` is proxied
server-side to FastAPI, so there is no CORS setup and the Python service does
not need to be exposed.

## Text to speech

The default engine is [Kokoro-82M](https://github.com/thewh1teagle/kokoro-onnx)
(Apache-2.0) running on CPU through onnxruntime. It is non-autoregressive, so
the same text always yields the same audio — it cannot hallucinate or drift
partway through a long book, which matters a great deal when a render takes
hours and nobody is listening to check.

Download the weights into a directory outside `data/`:

```bash
mkdir -p models && cd models
BASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
curl -LO $BASE/kokoro-v1.0.onnx   # fp32, 311 MB
curl -LO $BASE/voices-v1.0.bin    # 27 MB, 54 voices
```

Point the API at them with `NAB_MODELS_DIR` if they are not in `../models`.

Use the fp32 build. The int8 one is a third of the size and measured about
**five times slower** on every CPU tested — quantised kernels lose to
onnxruntime's optimised fp32 paths for this model. Do not bother downloading it.

`NAB_ONNX_THREADS` defaults to 4. Kokoro stops scaling past roughly 8 threads
and gets slower once SMT siblings are used, so raising it mostly costs the rest
of the machine its cores for very little return.

Every engine sits behind the `TTSBackend` protocol in `tts/base.py`. Adding one
means writing a new file and registering it — never touching the pipeline, the
routes or the worker.

### Benchmarking

Real-time factor decides how the rest of the system is built, so measure it
rather than guessing:

```bash
cd api && uv run python scripts/benchmark_tts.py
```

## Offloading synthesis to another machine

Synthesis is the slow part, and it does not have to happen on the host that
serves the site. A second machine can run a **worker node** — a stateless
service whose entire surface is "text in, audio out". It holds no book state,
no database and no output; the only thing crossing the network is a few hundred
bytes of text and a few seconds of PCM.

On the GPU machine:

```bash
uv sync
uv pip uninstall onnxruntime && uv pip install onnxruntime-gpu
NAB_ROLE=worker-node NAB_TTS_DEVICE=cuda NAB_REMOTE_WORKER_TOKEN=<secret> \
  uv run uvicorn naudiobooker.main:app --host 0.0.0.0 --port 8001
```

Check `GET /node/health` and confirm the log says
`Kokoro running on CUDAExecutionProvider`. If it says CPU, onnxruntime-gpu is
not installed or cannot see the card — and the node will be slower than the
machine you were offloading from.

On the host:

```bash
NAB_TTS_BACKEND=remote
NAB_REMOTE_WORKER_URL=http://gpu-box.lan:8001
NAB_REMOTE_WORKER_TOKEN=<same secret>
```

There is also `docker-compose.node.yml` for the GPU side.

**An unreachable node degrades rather than fails.** A desktop that sleeps or
reboots would otherwise kill a multi-hour render, so the dispatcher falls back
to local CPU and re-probes every couple of minutes. This is safe because the
chunk cache is keyed on the *model*, not on which machine produced the audio:
chunks already synthesized stay valid across the switch, and a render can start
on the GPU and finish on CPU without redoing a thing.

## Tests

```bash
pnpm test:api
```

Nothing in the suite loads a TTS model; the TTS layer is tested through a fake
backend implementing the same protocol, so tests run on a fresh checkout.

## Notes for contributors

Nothing calls a TTS model yet. When that lands it goes behind the backend
interface described in PLAN.md — do not import a model directly into a route.

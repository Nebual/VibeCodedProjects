# NAudioBooker — Plan

Turn an EPUB into an audiobook: per-chapter MP3s with correct metadata (optionally a single
M4B with chapter markers).

## Decisions

| Area | Choice |
|---|---|
| Site | Nuxt 4, Tailwind CSS v4, DaisyUI 5, Node 24, pnpm |
| Backend | Python 3.12 + FastAPI |
| TTS (v1) | Kokoro-82M, CPU, behind a pluggable backend interface |
| Primary host | Linux box (Ryzen 9800X3D, CPU inference) |
| GPU | Optional remote worker on the Windows box (RTX 3070) |
| RX 580 | Not used. Polaris/gfx803 was dropped from ROCm; no modern PyTorch support. |
| Job state | SQLite + a worker process. No Redis/Celery. |

## Architecture

```
┌─ Linux box ──────────────────────────────────────────────┐
│                                                          │
│  Nuxt 4 (:3000)                                          │
│    └─ server/api/* proxies to FastAPI (single origin,    │
│       no CORS, API not exposed to the browser)           │
│                                                          │
│  FastAPI (:8000, role=api)                               │
│    upload → parse → review → enqueue → SSE progress      │
│                                                          │
│  Worker process (role=worker)                            │
│    normalize → chunk → synthesize → assemble → tag       │
│                          │                               │
│                          ├─ KokoroLocalBackend (CPU)     │
│                          └─ RemoteHttpBackend ───────────┼──┐
│                                                          │  │
│  SQLite (jobs, books, chapters) + data/ on disk          │  │
└──────────────────────────────────────────────────────────┘  │
                                                              │
┌─ Windows box (optional) ─────────────────────────────────┐  │
│  Same package, role=worker-node, :8001                   │◀─┘
│  POST /synthesize  {text, voice, speed} → wav bytes      │
│  KokoroCudaBackend (or Chatterbox later) on the 3070     │
│  Shared-secret bearer token, LAN only                    │
└──────────────────────────────────────────────────────────┘
```

**Why the seam is at `synthesize()`:** it is stateless, the payloads are tiny (a few hundred
bytes of text in, a few seconds of PCM out), and it means the GPU box needs no filesystem
access, no database, and no knowledge of books or jobs. If it's offline or unreachable, the
dispatcher health-checks it and falls back to local CPU mid-job without losing work.

### TTS backend interface

Everything hangs off this. Getting it right in Phase 2 is what makes Chatterbox / F5 / a
cloud API a day of work later instead of a refactor.

```python
@dataclass
class AudioChunk:
    samples: np.ndarray   # float32 mono, [-1, 1]
    sample_rate: int

class TTSBackend(Protocol):
    id: str
    model_version: str          # part of the cache key

    async def voices(self) -> list[Voice]: ...
    async def synthesize(self, text: str, voice: str, speed: float = 1.0) -> AudioChunk: ...
    async def health(self) -> BackendHealth: ...
    @property
    def max_chars(self) -> int: ...   # backend-specific chunk sizing
```

Implementations: `KokoroLocalBackend`, `RemoteHttpBackend`, `PiperBackend` (fallback),
later `ChatterboxBackend`, `AzureBackend`.

### Chunk cache

`sha256(backend_id | model_version | voice | speed | normalized_text)` → wav on disk.

This is the single highest-leverage design element. It makes re-rendering one fixed chapter
near-instant, makes a crashed job resumable for free, and makes tweaking a pronunciation
entry cost only the chunks that actually changed.

## Pipeline

1. **Upload** → `data/books/<id>/source.epub`
2. **Parse** — `ebooklib` for the spine, nav doc / NCX for the chapter tree. Reconcile the two;
   the nav is authoritative for titles, the spine for order and for content the nav omits.
3. **Clean** — lxml + rules: strip nav, running heads, page-number anchors, footnote markers
   and endnote back-links, image captions. Keep the raw extracted text per chapter for review.
4. **Review UI** — chapter list with detected title, word count, include/exclude toggle, and
   the extracted text. Front matter, copyright pages, and indexes get unchecked here. *This
   step exists so a bad parse is caught in 30 seconds instead of after an hour of rendering.*
5. **Normalize** — numbers, currency, dates, ordinals, roman numerals, `Dr.`/`St.`/`Mr.`,
   em-dashes, ellipses, ALL-CAPS words. Plus a **per-book pronunciation dictionary** so proper
   nouns can be corrected once and applied everywhere (essential for SF/fantasy).
6. **Chunk** — sentence-aware split targeting `backend.max_chars` (~350 for Kokoro), never
   splitting mid-sentence, preserving paragraph boundaries as longer pauses.
7. **Synthesize** — per chunk, cache-checked, dispatched to local or remote backend.
8. **Assemble** — concatenate with short silence between sentences and longer between
   paragraphs, short crossfades at joins, then loudness-normalize toward the ACX target
   (RMS −23 to −18 dBFS, true peak ≤ −3 dBFS).
9. **Encode + tag** — ffmpeg → MP3. `mutagen` for ID3v2.4: `TALB` book title, `TPE1` author,
   `TIT2` chapter title, `TRCK`, `TCON=Audiobook`, `APIC` cover from the epub manifest.
   Optional single M4B via ffmpeg chapter-metadata file.
10. **Download** — zip of MP3s, or the M4B.

## Phases

**Phase 0 — Scaffolding. ✅ Done.** pnpm workspace + Nuxt 4 app, Python package with uv, both
running, Nuxt proxy route hitting FastAPI `/health`. Docker Compose for the Linux box.

**Phase 1 — Epub → text. ✅ Done.** Parse, clean, chapter tree, review UI. No audio at all.
Verified against *Walkaway* plus 31 unit tests over synthetic EPUBs (NCX-only, nav-only,
fragment-split files, no TOC, nested parts, bad encodings). Still worth running a wider spread
of real books through it — Gutenberg, Calibre-converted, Kindle-exported, scanned-OCR — since
that is where the remaining bugs live.

**Phase 2 — Kokoro + backend interface. ✅ Done.** `TTSBackend` protocol, `KokoroLocalBackend`
via `kokoro-onnx`/onnxruntime, 54 voices, sentence-aware chunker, and a preview endpoint.
System dep: `espeak-ng`, for G2P on out-of-dictionary words.

### Measured real-time factor

Both machines, 40 chunks of real prose, `scripts/benchmark_tts.py`. RTF is audio seconds
produced per wall-clock second; "book" is a 160,404-word novel (~17.8 h of audio).

| Machine | Model | Threads | RTF | Book render |
|---|---|---|---|---|
| Ryzen 9800X3D (Windows box) | fp32 | 8 | 10.2× | 1.75 h |
| Ryzen 9800X3D | fp32 | 4 | 8.8× | 2.03 h |
| Linux host | fp32 | 8 | 2.3× | 7.6 h |
| Linux host | fp32 | 4 | 2.0× | 9.0 h |
| either | int8 | any | 0.5–1.8× | 10–35 h |

Three findings that shaped the defaults:

- **int8 is roughly 5× slower than fp32**, consistently, on both machines. The intuition that
  a smaller model runs faster is simply wrong here: quantised kernels lose to onnxruntime's
  optimised fp32 paths for this model's op mix. The int8 build is not worth downloading.
- **Threads stop helping at about 8 and get worse at 16.** Once SMT siblings are in play the
  contention costs more than the parallelism gains.
- **The default is fp32 at 4 threads**, which gives up ~13% of throughput to leave the Linux
  host usable for its other jobs. Override with `NAB_ONNX_THREADS`.

**This raises the value of Phase 5 considerably.** A book is ~9 h on the Linux host but
~2 h on the Windows box's CPU alone, before the 3070 is involved at all. Offloading
synthesis is now the difference between an overnight job and a coffee break, not a
micro-optimisation.

**Phase 3 — Jobs. ✅ Done.** SQLite (WAL) schema, a separate worker process, the chunk cache,
SSE progress, cancel and resume. Verified end to end: a 450-second render took ~40 s of wall
clock, and re-rendering the same selection completed in 2 s with 46/46 chunks served from
cache.

Output is per-chapter WAV with naive gaps between chunks — provisional, and replaced by
Phase 4's proper assembly, loudness normalisation and encoding.

**Phase 4 — Output. ✅ Done.** Loudness normalisation, MP3 encode with ID3 tags and cover art,
single-file M4B with chapter markers, and download.

### Loudness needs a limiter, not just gain

The first implementation applied gain and clamped it so peaks stayed under -3 dBFS. That is
the obvious design and it does not work. Synthesized narration measures ~18 dB of crest factor
per chunk, and more across a chapter once the silence between chunks pulls the average down
while the peak stays put. A -3 dBFS ceiling therefore caps achievable RMS around -26 dBFS —
three decibels below the bottom of the ACX window. Measured output confirmed it: -26.0 and
-25.0 dBFS.

Real audiobook mastering uses a limiter, so the pipeline now does too: gain for the RMS
target, then a lookahead limiter holds the ceiling. When that would demand more than 8 dB of
reduction the gain is backed off instead, because audibly squashed narration is worse than
quiet narration. Output now measures -20.5, -20.5 and -20.1 dBFS with peaks at the ceiling.

Two traps worth remembering: ffmpeg's `alimiter` **auto-levels by default** (`level=disabled`
is required, or it normalises straight back to full scale and defeats the ceiling), and a pure
sine has only ~3 dB of crest, so testing normalisation with one hides this entire class of bug.

**Phase 5 — Remote GPU. ✅ Done.** `role=worker-node`, `RemoteHttpBackend`, fallback
dispatcher, bearer-token auth, CUDA provider selection, and deployment for the GPU box.

Verified with two live processes: a node synthesized all 46 chunks of a render, and the
dispatcher fell back to local CPU when pointed at a dead address.

**The cache key was wrong, and only a live test showed it.** It included the backend id, so
`kokoro` and `remote` produced different keys for byte-identical audio. A remote render
therefore shared nothing with a local one — and a mid-job fallback would have discarded every
chunk already synthesized, defeating the entire point of falling back. The key is now the
*model*, not the transport. Confirmed: rendering on the node then re-rendering locally hit
46/46 cache entries in 4 seconds.

No GPU exists in this sandbox, so CUDA provider selection is implemented and logged but
unverified on real hardware. The log line reports whichever provider onnxruntime actually
chose, because a silent fall back to CPU on the node is otherwise invisible until a render
takes nine hours.

Note: HuggingFace is blocked by the sandbox network policy (403), so any model distributed
only via HF — Chatterbox, F5-TTS — needs `sbx policy allow network huggingface.co` before it
can be evaluated here. Kokoro was fine because its ONNX weights live on GitHub releases.

**Phase 6 — Polish.** Pronunciation dictionary UI, per-chapter re-render, voice-per-chapter
overrides, library view.

## Open questions for later

- Multi-voice? (narrator vs. dialogue) — needs speaker attribution, a real project. Defer.
- Do we want ASR round-trip validation? Not needed for Kokoro (deterministic, no drift), but
  mandatory if we add an autoregressive backend in Phase 5+.
- Auth on the web app, or LAN-trusted only?

## Notes

- Tailwind v4 in Nuxt: use the `@tailwindcss/vite` plugin directly, not `@nuxtjs/tailwindcss`.
  DaisyUI 5 loads as a CSS plugin (`@plugin "daisyui";`).
- Kokoro is Apache-2.0. Piper is MIT. Both are fine for any use. If Chatterbox is added it's
  MIT too — but XTTS-v2 (CPML) and F5-TTS weights (CC-BY-NC) are **non-commercial**, so keep
  them out unless this stays personal.
- Kokoro outputs 24 kHz mono, which is correct for speech; don't upsample before encoding.
```
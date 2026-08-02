#!/usr/bin/env python
"""Measure synthesis speed on this machine.

RTF here is audio-seconds produced per second of wall clock, so 45x means a
45-minute chapter renders in a minute. It is the number that decides whether a
model is usable for a whole book or only for a chapter.

    uv run python scripts/benchmark_tts.py                      # Kokoro, CPU sweep
    uv run python scripts/benchmark_tts.py --device cuda        # Kokoro on GPU
    uv run python scripts/benchmark_tts.py --model omnivoice --device cuda \
        --ref-clip ../data/voices/<hash>.wav

Cloning models have no built-in voices, so they need --ref-clip (or any clip
already in the voice library, which is picked up automatically).

Only one of chatterbox-tts and omnivoice can be installed in a given
environment -- they pin incompatible transformers versions -- so a model whose
package is missing is reported and skipped rather than failing the run.
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from naudiobooker.config import Settings, get_settings  # noqa: E402
from naudiobooker.text import chunk_paragraphs  # noqa: E402
from naudiobooker.tts.base import BackendUnavailable, ReferenceClip  # noqa: E402
from naudiobooker.tts.models import ALL_MODELS, get_model  # noqa: E402
from naudiobooker.tts.registry import _local_backend  # noqa: E402

WORDS_PER_MINUTE = 150

#: Used when no EPUB is supplied, so the benchmark runs on a GPU node that has
#: the model but no library. Ordinary declarative prose with the punctuation and
#: sentence lengths narration actually contains; phonemisation and text encoding
#: cost varies with the text, so a synthetic string of one repeated word would
#: flatter the numbers.
FALLBACK_PARAGRAPHS = [
    "The survey team reached the ridge a little after four in the afternoon, "
    "later than they had planned and colder than anyone had dressed for. "
    "Below them the valley held its shape under a thin, even layer of snow.",
    "She checked the readings twice before writing them down. The instrument "
    "had been wrong once already that week, and a second mistake would mean "
    "carrying everything back up the slope in the morning.",
    "There were three ways down, and all of them were bad. The first was "
    "quick and steep; the second added an hour but stayed in the trees; the "
    "third nobody had walked in years, which was reason enough to leave it.",
    "By six the light had gone amber and then blue. They ate standing up, "
    "passing a stove between them, and argued in the mild way of people who "
    "have already decided and are only settling the order of things.",
    "In the morning the wind had turned. The tracks they had made coming in "
    "were gone, filled and smoothed until the whole slope looked untouched, "
    "as though the mountain had quietly declined to remember them.",
]


def load_chunks(epub: Path | None, count: int, max_chars: int) -> list[str]:
    if epub is None or not epub.exists():
        paragraphs = (FALLBACK_PARAGRAPHS * (count // len(FALLBACK_PARAGRAPHS) + 2))[: count + 4]
        return [c.text for c in chunk_paragraphs(paragraphs, max_chars)][:count]

    from naudiobooker.epub import build_chapters, open_epub

    pkg, zf = open_epub(epub)
    try:
        chapters = build_chapters(pkg, zf.read)
    finally:
        zf.close()

    body = max(chapters, key=lambda c: c.word_count)
    chunks = chunk_paragraphs(body.paragraphs, max_chars)
    # Skip the opening: chapter headings are unusually short and would flatter
    # the numbers by amortising fixed per-call overhead over less audio.
    return [c.text for c in chunks[10 : 10 + count]]


def find_reference(explicit: Path | None) -> ReferenceClip | None:
    """A reference clip for the cloning models."""
    if explicit is not None:
        if not explicit.exists():
            raise SystemExit(f"--ref-clip {explicit} does not exist")
        import hashlib

        return ReferenceClip(
            path=explicit,
            ref_hash=hashlib.sha256(explicit.read_bytes()).hexdigest(),
        )

    from naudiobooker.voices import VoiceLibrary

    library = VoiceLibrary.open()
    clips = library.all()
    if not clips:
        return None
    clip = clips[0]
    return ReferenceClip(path=library.path_for(clip), ref_hash=clip.ref_hash)


def measure(backend, chunks: list[str], voice: str, reference) -> tuple[float, float, list[float]]:
    backend.synthesize(chunks[0], voice, 1.0, reference)  # warm up: excludes model load

    audio_s = 0.0
    per_chunk: list[float] = []
    start = time.perf_counter()
    for text in chunks:
        t0 = time.perf_counter()
        chunk = backend.synthesize(text, voice, 1.0, reference)
        per_chunk.append(time.perf_counter() - t0)
        audio_s += chunk.duration_s
    return time.perf_counter() - start, audio_s, per_chunk


def main() -> None:
    base = get_settings()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        default="kokoro",
        help="model id, or 'all' to try every one whose package is installed",
    )
    parser.add_argument("--epub", type=Path, default=None, help="defaults to built-in prose")
    parser.add_argument("--voice", default=None, help="defaults per model")
    parser.add_argument("--ref-clip", type=Path, default=None, help="for cloning models")
    parser.add_argument("--chunks", type=int, default=40)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument(
        "--threads", default="1,4,8,16", help="Kokoro CPU thread sweep; ignored elsewhere"
    )
    parser.add_argument("--book-words", type=int, default=160_404)
    args = parser.parse_args()

    wanted = [m.id for m in ALL_MODELS] if args.model == "all" else [args.model]
    reference = find_reference(args.ref_clip)

    print(f"device: {args.device}   chunks: {args.chunks}")
    if reference:
        print(f"reference clip: {reference.path.name}")
    print()
    header = f"{'model':>20} {'device':>7} {'thr':>4} {'audio':>9} {'wall':>8} {'RTF':>7}"
    print(f"{header}  {'book':>10}")
    print("-" * 72)

    best: tuple[float, str, list[float]] | None = None

    for model_id in wanted:
        spec = get_model(model_id)
        if spec.supports_cloning and reference is None:
            print(f"{model_id:>20}   skipped: needs --ref-clip (no voice clips found)")
            continue

        # Kokoro's thread count is an onnxruntime setting and genuinely changes
        # throughput; for the torch models it does nothing, so one run each.
        sweep = [int(t) for t in args.threads.split(",")] if spec.family == "kokoro" else [0]
        if args.device == "cuda" and spec.family == "kokoro":
            sweep = [0]

        for threads in sweep:
            settings = Settings(
                tts_device=args.device,
                onnx_threads=threads,
                models_dir=base.models_dir,
                data_dir=base.data_dir,
                _env_file=None,
            )
            try:
                backend = _local_backend(settings, spec)
                chunks = load_chunks(args.epub, args.chunks, backend.max_chars)
                voice = args.voice or ("af_heart" if spec.family == "kokoro" else "benchmark")
                wall, audio_s, per_chunk = measure(backend, chunks, voice, reference)
            except BackendUnavailable as exc:
                print(f"{model_id:>20}   unavailable: {str(exc)[:60]}")
                break
            except Exception as exc:  # noqa: BLE001 - report and continue
                print(f"{model_id:>20}   failed: {type(exc).__name__}: {str(exc)[:50]}")
                break

            rtf = audio_s / wall
            device = getattr(backend, "provider", None) or args.device
            device = str(device).replace("ExecutionProvider", "")
            book_h = (args.book_words / WORDS_PER_MINUTE * 60) / rtf / 3600

            # Never let a GPU run be reported without saying it fell back. A
            # silently-CPU benchmark is worse than no number, because it gets
            # written down and believed.
            if args.device == "cuda" and device.lower().startswith("cpu"):
                print(
                    f"{model_id:>20}   ABORTED: asked for CUDA but got CPU;"
                    " these numbers would be wrong"
                )
                break

            print(
                f"{model_id:>20} {device:>7} {threads or '-':>4} {audio_s:>8.1f}s"
                f" {wall:>7.1f}s {rtf:>6.2f}x {book_h:>8.2f} h"
            )
            if best is None or rtf > best[0]:
                best = (rtf, f"{model_id} on {device}", per_chunk)

            from naudiobooker.tts.base import unload_backend

            unload_backend(backend)

    if best:
        rtf, label, latencies = best
        book_h = (args.book_words / WORDS_PER_MINUTE * 60) / rtf / 3600
        print("-" * 72)
        print(f"best: {label} at {rtf:.2f}x real time")
        print(f"  a {args.book_words:,}-word book renders in about {book_h:.2f} hours")
        print(
            f"  per-chunk latency: median {statistics.median(latencies) * 1000:.0f} ms,"
            f" max {max(latencies) * 1000:.0f} ms"
        )


if __name__ == "__main__":
    main()

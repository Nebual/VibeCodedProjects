#!/usr/bin/env python
"""Measure Kokoro's real-time factor on this machine.

RTF is the ratio of audio produced to wall time spent, so 10x means ten seconds
of speech per second of compute. It is the number that decides everything
downstream: whether a book renders in minutes or hours, whether the job queue
needs to be resumable, and whether a GPU is worth wiring up at all.

Run from the api/ directory:

    uv run python scripts/benchmark_tts.py
    uv run python scripts/benchmark_tts.py --threads 8,16 --chunks 60
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from naudiobooker.epub import build_chapters, open_epub  # noqa: E402
from naudiobooker.text import chunk_paragraphs  # noqa: E402
from naudiobooker.tts.kokoro_local import MAX_CHARS  # noqa: E402

DEFAULT_EPUB = Path("../Sample Epub/Walkaway/Walkaway - Cory Doctorow.epub")
WORDS_PER_MINUTE = 150


def load_chunks(epub: Path, count: int) -> list[str]:
    """Real prose, not a synthetic string: phonemisation cost varies with it."""
    pkg, zf = open_epub(epub)
    try:
        chapters = build_chapters(pkg, zf.read)
    finally:
        zf.close()

    body = max(chapters, key=lambda c: c.word_count)
    chunks = chunk_paragraphs(body.paragraphs, MAX_CHARS)
    # Skip the opening: chapter headings are unusually short and would flatter
    # the numbers by amortising fixed per-call overhead over less audio.
    return [c.text for c in chunks[10 : 10 + count]]


def build(model: Path, voices: Path, threads: int):
    from kokoro_onnx import Kokoro

    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
    return Kokoro.from_session(session, str(voices))


def measure(kokoro, chunks: list[str], voice: str) -> tuple[float, float, list[float]]:
    kokoro.create(chunks[0], voice=voice, speed=1.0, lang="en-us")  # warm up

    audio_s = 0.0
    per_chunk: list[float] = []
    start = time.perf_counter()
    for text in chunks:
        t0 = time.perf_counter()
        samples, sample_rate = kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
        per_chunk.append(time.perf_counter() - t0)
        audio_s += len(samples) / sample_rate
    return time.perf_counter() - start, audio_s, per_chunk


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epub", type=Path, default=DEFAULT_EPUB)
    parser.add_argument("--models-dir", type=Path, default=Path("/home/agent/models"))
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--chunks", type=int, default=40)
    parser.add_argument("--threads", default="1,4,8,16")
    parser.add_argument("--book-words", type=int, default=160_404, help="for the projection")
    args = parser.parse_args()

    thread_counts = [int(t) for t in args.threads.split(",")]
    voices_path = args.models_dir / "voices-v1.0.bin"
    variants = [
        (name, args.models_dir / filename)
        for name, filename in (("fp32", "kokoro-v1.0.onnx"), ("int8", "kokoro-v1.0.int8.onnx"))
        if (args.models_dir / filename).exists()
    ]
    if not variants:
        raise SystemExit(f"no Kokoro model files found in {args.models_dir}")

    chunks = load_chunks(args.epub, args.chunks)
    chars = sum(len(c) for c in chunks)
    print(f"{len(chunks)} chunks, {chars:,} chars of real prose, voice={args.voice}")
    print(f"cpu threads available: {ort.get_all_providers() and __import__('os').cpu_count()}\n")

    print(f"{'model':>6} {'threads':>8} {'audio':>9} {'wall':>8} {'RTF':>7}  {'book render':>12}")
    print("-" * 60)

    best: tuple[float, str, list[float]] | None = None
    for name, path in variants:
        for threads in thread_counts:
            kokoro = build(path, voices_path, threads)
            wall, audio_s, per_chunk = measure(kokoro, chunks, args.voice)
            rtf = audio_s / wall
            book_s = (args.book_words / WORDS_PER_MINUTE * 60) / rtf
            print(
                f"{name:>6} {threads:>8} {audio_s:>8.1f}s {wall:>7.1f}s {rtf:>6.1f}x"
                f"  {book_s / 3600:>9.2f} h"
            )
            # Carry this run's latencies with its score. Reading them from the
            # loop variable afterwards would report the *last* configuration
            # measured, not the best one.
            if best is None or rtf > best[0]:
                best = (rtf, f"{name} @ {threads} threads", per_chunk)
            del kokoro

    if best:
        rtf, label, latencies = best
        book_h = (args.book_words / WORDS_PER_MINUTE * 60) / rtf / 3600
        print("-" * 60)
        print(f"best: {label} at {rtf:.1f}x real time")
        print(f"  a {args.book_words:,}-word book renders in about {book_h:.2f} hours")
        print("  per-chunk latency (governs how snappy a preview feels):")
        print(
            f"    median {statistics.median(latencies) * 1000:.0f} ms,"
            f" max {max(latencies) * 1000:.0f} ms"
        )


if __name__ == "__main__":
    main()

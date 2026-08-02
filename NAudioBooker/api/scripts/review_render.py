#!/usr/bin/env python
"""Render chapters for listening review, flagging chunks that phonemized badly.

espeak emits "words count mismatch" when the phoneme stream it produced does not
line up with the words it was given. That usually means something in the text
was mangled -- a symbol read as a word, a token dropped -- so those chunks are
the ones worth actually listening to.

The warnings arrive on a module logger with no reference to the text that caused
them, so this captures the logger around each individual synthesis call to
attribute them. Cached audio is deliberately bypassed: a cache hit performs no
phonemisation and would report nothing.

    uv run python scripts/review_render.py --book <id> --out ../data/review
"""

from __future__ import annotations

import argparse
import csv
import logging
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from naudiobooker import store  # noqa: E402
from naudiobooker.config import get_settings  # noqa: E402
from naudiobooker.text import chunk_paragraphs  # noqa: E402
from naudiobooker.tts import get_backend  # noqa: E402
from naudiobooker.worker.runner import PARAGRAPH_GAP_S, SENTENCE_GAP_S  # noqa: E402


class WarningCapture(logging.Handler):
    """Collects phonemizer warnings emitted while it is installed.

    Installed on the *root* logger, not on ``phonemizer``. phonemizer replaces
    its own logger's handler list when the espeak backend initialises, which
    silently discards anything attached there beforehand -- the capture then
    reports zero warnings while espeak is visibly emitting them. Records still
    propagate to root, so that is the reliable place to listen.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        if record.name.startswith("phonemizer"):
            self.messages.append(record.getMessage())


@dataclass
class Flagged:
    chapter_index: int
    chapter_title: str
    chunk_index: int
    offset_s: float
    text: str
    warnings: list[str]


def to_mp3(wav: Path, mp3: Path) -> bool:
    mp3.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(wav),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "96k",
            "-ac",
            "1",
            str(mp3),
        ],
        capture_output=True,
    )
    return result.returncode == 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--book", required=True, help="book id")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--chapters", default="", help="comma-separated indices")
    args = parser.parse_args()

    settings = get_settings()
    backend = get_backend(settings)
    book = store.load_book(args.book)

    wanted = (
        {int(x) for x in args.chapters.split(",") if x.strip()}
        if args.chapters
        else {c.index for c in book.chapters if c.include}
    )
    chapters = [c for c in book.chapters if c.index in wanted]

    out = args.out / args.book
    (out / "chapters").mkdir(parents=True, exist_ok=True)
    (out / "flagged").mkdir(parents=True, exist_ok=True)

    capture = WarningCapture()
    root_log = logging.getLogger()
    root_log.addHandler(capture)
    root_log.setLevel(logging.WARNING)

    flagged: list[Flagged] = []
    totals = {"chunks": 0, "flagged": 0}

    for chapter in chapters:
        text = store.chapter_text(args.book, chapter.index)
        chunks = chunk_paragraphs(text.paragraphs, backend.max_chars)
        print(f"[{chapter.index:>3}] {chapter.title[:44]:<44} {len(chunks):>4} chunks", flush=True)

        wav = out / "chapters" / f"{chapter.index:03d}.wav"
        offset = 0.0
        with sf.SoundFile(
            wav, "w", samplerate=backend.sample_rate, channels=1, subtype="PCM_16"
        ) as sink:
            for position, chunk in enumerate(chunks):
                capture.messages.clear()
                audio = backend.synthesize(chunk.text, args.voice, args.speed)
                totals["chunks"] += 1

                if capture.messages:
                    totals["flagged"] += 1
                    flagged.append(
                        Flagged(
                            chapter_index=chapter.index,
                            chapter_title=chapter.title,
                            chunk_index=position,
                            offset_s=offset,
                            text=chunk.text,
                            warnings=list(capture.messages),
                        )
                    )
                    clip = out / "flagged" / f"{chapter.index:03d}-{position:04d}.wav"
                    sf.write(clip, audio.samples, audio.sample_rate, subtype="PCM_16")

                sink.write(np.asarray(audio.samples, dtype=np.float32))
                offset += audio.duration_s
                if position < len(chunks) - 1:
                    gap = PARAGRAPH_GAP_S if chunk.ends_paragraph else SENTENCE_GAP_S
                    sink.write(np.zeros(int(gap * backend.sample_rate), dtype=np.float32))
                    offset += gap

        title = "".join(ch if ch.isalnum() or ch in " -_" else "" for ch in chapter.title)[:40]
        if to_mp3(wav, out / "chapters" / f"{chapter.index:03d} {title.strip()}.mp3"):
            wav.unlink()

    root_log.removeHandler(capture)

    # Convert flagged clips too, then drop the wavs.
    for clip in sorted((out / "flagged").glob("*.wav")):
        if to_mp3(clip, clip.with_suffix(".mp3")):
            clip.unlink()

    with (out / "flagged.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["chapter", "title", "chunk", "offset_s", "chars", "warning", "text"])
        for f in flagged:
            writer.writerow(
                [
                    f.chapter_index,
                    f.chapter_title,
                    f.chunk_index,
                    f"{f.offset_s:.1f}",
                    len(f.text),
                    " | ".join(f.warnings),
                    f.text,
                ]
            )

    print(
        f"\n{totals['flagged']} of {totals['chunks']} chunks flagged "
        f"({totals['flagged'] / max(totals['chunks'], 1):.0%})"
    )
    print(f"written to {out}")


if __name__ == "__main__":
    main()

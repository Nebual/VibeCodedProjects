"""Build a single M4B with chapter markers.

M4B is what audiobook players actually want: one file, chapters you can skip
between, and a remembered playback position. A folder of MP3s works, but every
player treats it as an album and most forget where you were.

Built from the chapter WAVs in one pass with ffmpeg. Going via the
already-encoded MP3s would be simpler but would stack a second lossy
generation on top of the first.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

from .encode import EncodeError, _run, loudness_filter


@dataclass(frozen=True)
class M4BChapter:
    title: str
    source: Path
    duration_s: float


#: Used only when the inputs disagree and we cannot tell what to prefer.
_FALLBACK_RATE = 44_100


def _common_rate(chapters: list[M4BChapter]) -> int | None:
    """The rate everything must be resampled to, or None if they already agree.

    The concat filter requires its inputs to match, which the old
    unconditional ``aresample=44100`` quietly guaranteed. Dropping it means
    checking: chapters from one render always share a rate, but a job that
    fell back between backends mid-way might not, and that must stay a
    working build rather than an ffmpeg error.

    Reads headers only -- no decoding.
    """
    rates = set()
    for chapter in chapters:
        try:
            rates.add(int(sf.info(str(chapter.source)).samplerate))
        except Exception:
            # Unreadable header: fall back to the old behaviour rather than
            # gamble that the inputs happen to agree.
            return _FALLBACK_RATE

    if len(rates) <= 1:
        return None
    return max(rates)


def _escape(value: str) -> str:
    """Escape a value for an ffmetadata field."""
    out = []
    for ch in value:
        if ch in "=;#\\\n":
            out.append("\\")
        out.append(ch)
    return "".join(out)


def build_metadata(
    chapters: list[M4BChapter],
    *,
    title: str,
    artist: str,
    year: str | None = None,
) -> str:
    lines = [
        ";FFMETADATA1",
        f"title={_escape(title)}",
        f"album={_escape(title)}",
        f"artist={_escape(artist)}",
        f"album_artist={_escape(artist)}",
        "genre=Audiobook",
        "media_type=2",  # marks the file as an audiobook for Apple players
    ]
    if year:
        lines.append(f"date={_escape(year)}")

    # Chapter marks are cumulative offsets, in milliseconds.
    start_ms = 0
    for chapter in chapters:
        end_ms = start_ms + int(round(chapter.duration_s * 1000))
        lines += [
            "",
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={start_ms}",
            # End one millisecond before the next chapter starts; overlapping
            # marks make some players skip a chapter entirely.
            f"END={max(end_ms - 1, start_ms)}",
            f"title={_escape(chapter.title)}",
        ]
        start_ms = end_ms

    return "\n".join(lines) + "\n"


def build_m4b(
    chapters: list[M4BChapter],
    destination: Path,
    *,
    title: str,
    artist: str,
    year: str | None = None,
    cover: Path | None = None,
    bitrate: str = "64k",
    work_dir: Path | None = None,
    gain_db: float = 0.0,
    limit_dbfs: float | None = None,
    sample_rate: int | None = None,
) -> None:
    if not chapters:
        raise EncodeError("cannot build an M4B with no chapters")

    destination.parent.mkdir(parents=True, exist_ok=True)
    work_dir = work_dir or destination.parent
    work_dir.mkdir(parents=True, exist_ok=True)

    metadata_path = work_dir / "chapters.ffmetadata"
    metadata_path.write_text(
        build_metadata(chapters, title=title, artist=artist, year=year),
        encoding="utf-8",
    )

    args: list[str] = ["ffmpeg", "-y", "-loglevel", "error"]
    for chapter in chapters:
        args += ["-i", str(chapter.source)]

    metadata_index = len(chapters)
    args += ["-i", str(metadata_path)]

    cover_index = None
    if cover is not None and cover.exists():
        cover_index = metadata_index + 1
        args += ["-i", str(cover)]

    # Concatenate first, then correct once. The whole book shares one gain, so
    # N copies of the same filter chain would be N limiter instances doing
    # identical work -- and a limiter applied across the joins rather than
    # separately on each side of them is the more correct of the two anyway.
    graph = "".join(f"[{i}:a]" for i in range(len(chapters)))
    graph += f"concat=n={len(chapters)}:v=0:a=1[joined];"
    chain = [loudness_filter(gain_db, limit_dbfs)]

    # Resample only when there is a reason to. The source is 24 kHz and AAC
    # encodes that natively, so the 44.1 kHz upsample this used to do
    # unconditionally added no information while making the encoder chew
    # through 1.84x as many samples -- about 30% of this stage.
    target = sample_rate or _common_rate(chapters)
    if target is not None:
        chain.append(f"aresample={target}")
    graph += f"[joined]{','.join(chain)}[out]"

    args += ["-filter_complex", graph, "-map", "[out]"]
    if cover_index is not None:
        args += ["-map", f"{cover_index}:v", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic"]
    args += [
        "-map_metadata",
        str(metadata_index),
        "-c:a",
        "aac",
        "-b:a",
        bitrate,
        "-ac",
        "1",
        "-movflags",
        "+faststart",
        "-f",
        "ipod",
        str(destination),
    ]

    _run(args)
    metadata_path.unlink(missing_ok=True)

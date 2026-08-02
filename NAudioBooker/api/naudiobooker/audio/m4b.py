"""Build a single M4B with chapter markers.

M4B is what audiobook players actually want: one file, chapters you can skip
between, and a remembered playback position. A folder of MP3s works, but every
player treats it as an album and most forget where you were.

Built from the chapter WAVs in one pass using ffmpeg's concat *filter* rather
than the concat demuxer, because each chapter carries its own loudness
correction and the filter graph is the only way to apply a different gain per
input. Going via the already-encoded MP3s would be simpler but would stack a
second lossy generation on top of the first.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .encode import EncodeError, _run, loudness_filter


@dataclass(frozen=True)
class M4BChapter:
    title: str
    source: Path
    duration_s: float
    gain_db: float = 0.0
    limit_dbfs: float | None = None


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

    # Per-input gain and limiting, then concatenate. Each chapter carries its
    # own correction, which is why this uses the concat filter rather than the
    # simpler concat demuxer.
    graph = "".join(
        f"[{i}:a]{loudness_filter(c.gain_db, c.limit_dbfs)},aresample=44100[a{i}];"
        for i, c in enumerate(chapters)
    )
    graph += "".join(f"[a{i}]" for i in range(len(chapters)))
    graph += f"concat=n={len(chapters)}:v=0:a=1[out]"

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

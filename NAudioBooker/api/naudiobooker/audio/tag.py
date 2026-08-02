"""ID3 tagging for the per-chapter MP3s.

Players group tracks by album and order them by track number, so an audiobook
with the wrong tags plays its chapters in filename order or scatters them
across the library. The tags matter as much as the audio.
"""

from __future__ import annotations

import mimetypes
from dataclasses import dataclass
from pathlib import Path

from mutagen.id3 import (
    APIC,
    ID3,
    TALB,
    TCON,
    TIT2,
    TPE1,
    TPE2,
    TRCK,
    TYER,
    ID3NoHeaderError,
)


@dataclass(frozen=True)
class TrackTags:
    title: str
    album: str
    artist: str
    track: int
    total_tracks: int
    year: str | None = None
    genre: str = "Audiobook"


def tag_mp3(path: Path, tags: TrackTags, cover: Path | None = None) -> None:
    try:
        audio = ID3(path)
    except ID3NoHeaderError:
        audio = ID3()

    audio.setall("TIT2", [TIT2(encoding=3, text=tags.title)])
    audio.setall("TALB", [TALB(encoding=3, text=tags.album)])
    audio.setall("TPE1", [TPE1(encoding=3, text=tags.artist)])
    # Album artist too: without it, players that group by album artist scatter
    # a multi-author anthology across several entries.
    audio.setall("TPE2", [TPE2(encoding=3, text=tags.artist)])
    audio.setall("TRCK", [TRCK(encoding=3, text=f"{tags.track}/{tags.total_tracks}")])
    audio.setall("TCON", [TCON(encoding=3, text=tags.genre)])
    if tags.year:
        audio.setall("TYER", [TYER(encoding=3, text=tags.year)])

    if cover is not None and cover.exists():
        mime = mimetypes.guess_type(cover.name)[0] or "image/jpeg"
        audio.setall(
            "APIC",
            [
                APIC(
                    encoding=3,
                    mime=mime,
                    type=3,  # front cover
                    desc="Cover",
                    data=cover.read_bytes(),
                )
            ],
        )

    # v2.3 alongside v2.4: some hardware players and car head units still do
    # not read v2.4 frames.
    audio.save(path, v2_version=3)

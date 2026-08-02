"""Audio encoding: WAV in memory, MP3 and M4B on disk via ffmpeg."""

from __future__ import annotations

import io
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from ..tts.base import AudioChunk


class EncodeError(Exception):
    pass


def to_wav_bytes(chunk: AudioChunk, subtype: str = "PCM_16") -> bytes:
    """Encode a chunk as a WAV file in memory.

    16-bit PCM rather than the model's native float32: it halves the size for
    no audible loss at 24 kHz speech, and every browser can play it.
    """
    samples = np.asarray(chunk.samples, dtype=np.float32)
    buffer = io.BytesIO()
    sf.write(buffer, samples, chunk.sample_rate, format="WAV", subtype=subtype)
    return buffer.getvalue()


def _run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        # ffmpeg puts the useful part at the end of a very long stderr.
        tail = "\n".join(result.stderr.strip().splitlines()[-4:])
        raise EncodeError(f"ffmpeg failed: {tail}")


def loudness_filter(gain_db: float, limit_dbfs: float | None) -> str:
    """ffmpeg filter chain applying gain then holding a peak ceiling.

    ``level=disabled`` is essential: alimiter's auto-level is on by default and
    would normalise everything back up to full scale, silently undoing the gain
    staging and blowing straight through the ceiling it was added to enforce.
    """
    parts = [f"volume={gain_db:.2f}dB"]
    if limit_dbfs is not None:
        limit = 10.0 ** (limit_dbfs / 20.0)
        parts.append(f"alimiter=limit={limit:.4f}:level=disabled:attack=5:release=50")
    return ",".join(parts)


def wav_to_mp3(
    source: Path,
    destination: Path,
    *,
    gain_db: float = 0.0,
    limit_dbfs: float | None = None,
    bitrate: str = "96k",
) -> None:
    """Encode to mono MP3, applying gain and limiting on the way through.

    Doing it during encode rather than rewriting the WAV first avoids a second
    full pass over what may be hours of audio.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    filters: list[str] = []
    if abs(gain_db) >= 0.01 or limit_dbfs is not None:
        filters = ["-af", loudness_filter(gain_db, limit_dbfs)]
    _run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(source),
            *filters,
            "-codec:a",
            "libmp3lame",
            "-b:a",
            bitrate,
            "-ac",
            "1",
            str(destination),
        ]
    )


def probe_duration(path: Path) -> float:
    """Duration in seconds, read from the container rather than decoded."""
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise EncodeError(f"ffprobe failed on {path.name}: {result.stderr.strip()[:200]}")
    try:
        return float(result.stdout.strip())
    except ValueError as exc:
        raise EncodeError(f"ffprobe gave no duration for {path.name}") from exc


#: Frame size and rate for the still-image video track below. Small and slow:
#: it exists only to satisfy players that will not accept an audio-only MP4,
#: and every extra pixel is bytes spent conveying nothing.
_CARD_SIZE = "640x360"
_CARD_FPS = 10
_CARD_COLOUR = "0x1d232a"


def audio_to_mp4(wav_bytes: bytes, *, bitrate: str = "96k") -> bytes:
    """Wrap audio in an MP4 with a still-image video track.

    For sharing a preview somewhere that will not play bare audio. Discord is
    the case in hand: it has no audio embed at all -- og:audio is unimplemented
    and a direct link to an audio file gets no player -- but it will embed an
    MP4 advertised through og:video. An audio-only MP4 is not reliably treated
    as a video, hence the blank frame.

    Encoded rather than cached: a still frame at 10 fps costs a few hundred
    kilobytes a minute and about a twentieth of a second, which is far less
    than the synthesis that produced the audio.
    """
    with tempfile.TemporaryDirectory() as work:
        source = Path(work) / "audio.wav"
        destination = Path(work) / "card.mp4"
        source.write_bytes(wav_bytes)

        _run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                # An endless colour source; -shortest below cuts it to the audio.
                "-f",
                "lavfi",
                "-i",
                f"color=c={_CARD_COLOUR}:s={_CARD_SIZE}:r={_CARD_FPS}",
                "-i",
                str(source),
                "-c:v",
                "libx264",
                "-tune",
                "stillimage",
                "-preset",
                "veryfast",
                # yuv420p because anything else fails to play in a lot of places.
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                bitrate,
                "-shortest",
                # Metadata at the front, so a player can start without the whole file.
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                str(destination),
            ]
        )
        return destination.read_bytes()

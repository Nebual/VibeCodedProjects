"""Content-addressed cache of synthesized audio chunks.

The highest-leverage piece of the render pipeline. Because the key covers
everything that affects the output, a chunk synthesized once never needs
synthesizing again, which buys three things at once:

- **Resume for free.** A worker killed three hours into a nine-hour book picks
  up where it left off; every completed chunk is already on disk.
- **Cheap corrections.** Fixing one pronunciation re-renders only the chunks
  whose text actually changed.
- **Cheap experiments.** Re-rendering a book with two chapters excluded costs
  nothing for the chapters that stayed.

The key identifies the *model*, not the transport that reached it. Audio made
by Kokoro fp32 is the same audio whether it was synthesized in this process or
fetched from a GPU node over HTTP, so both must land on the same key. Keying on
the backend id instead would mean a local render and a remote render of the
same book shared nothing -- and, worse, that falling back from the node to
local CPU mid-job invalidated every chunk already produced, which is precisely
what the fallback exists to avoid.

``model_version`` therefore has to be specific enough to stand alone: int8 and
fp32 produce audibly different audio from identical text, and serving one where
the other is expected would be a maddening bug to track down.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from .tts.base import AudioChunk


def chunk_key(
    *,
    model_version: str,
    voice: str,
    speed: float,
    text: str,
    voice_ref: str | None = None,
) -> str:
    """Key for one synthesized chunk.

    ``voice_ref`` is the content hash of a cloned voice's reference clip, and
    it is not optional in spirit: a cloned voice is named by the user, so the
    same name can be re-pointed at a completely different recording. Keying on
    the name alone would serve the old voice from cache forever, and the only
    symptom would be a book that stubbornly refuses to sound like the new clip.
    """
    digest = hashlib.sha256()
    # Length-prefixed so no combination of field values can collide with a
    # different combination by concatenating the same way.
    for part in (model_version, voice, voice_ref or "", f"{speed:.4f}", text):
        encoded = part.encode("utf-8")
        digest.update(str(len(encoded)).encode("ascii"))
        digest.update(b"\0")
        digest.update(encoded)
    return digest.hexdigest()


@dataclass
class ChunkCache:
    root: Path

    def path_for(self, key: str) -> Path:
        # Two levels of fan-out: a book is tens of thousands of chunks, and
        # directories with that many entries are slow to list on every
        # filesystem worth supporting.
        return self.root / key[:2] / key[2:4] / f"{key}.wav"

    def get(self, key: str) -> AudioChunk | None:
        path = self.path_for(key)
        if not path.exists():
            return None
        try:
            samples, sample_rate = sf.read(path, dtype="float32")
        except (sf.LibsndfileError, RuntimeError):
            # A truncated file from an interrupted write. Treat as a miss and
            # let it be overwritten rather than failing the whole render.
            path.unlink(missing_ok=True)
            return None
        return AudioChunk(samples=samples, sample_rate=sample_rate)

    def put(self, key: str, chunk: AudioChunk) -> Path:
        path = self.path_for(key)
        path.parent.mkdir(parents=True, exist_ok=True)

        # Write then rename: a worker killed mid-write must not leave a partial
        # file that a later run would happily read back as valid audio.
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        sf.write(
            tmp,
            np.asarray(chunk.samples, dtype=np.float32),
            chunk.sample_rate,
            format="WAV",
            subtype="PCM_16",
        )
        os.replace(tmp, path)
        return path

    def size_bytes(self) -> int:
        if not self.root.exists():
            return 0
        return sum(f.stat().st_size for f in self.root.rglob("*.wav"))

    def clear(self) -> int:
        removed = 0
        if not self.root.exists():
            return removed
        for f in self.root.rglob("*.wav"):
            f.unlink(missing_ok=True)
            removed += 1
        return removed

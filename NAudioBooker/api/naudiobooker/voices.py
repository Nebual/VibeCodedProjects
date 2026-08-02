"""Custom voices cloned from a user-supplied reference clip.

Clips are content-addressed. The hash is what the synthesis cache keys on, so
two voices pointing at byte-identical audio share cached chunks, and re-pointing
one name at a new recording correctly invalidates nothing else.

The name is only ever a label. Everything that affects the audio keys on the
hash.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import get_settings
from .tts.base import ReferenceClip
from .tts.models import ModelSpec

#: Both models want a short prompt: Chatterbox works from about five seconds,
#: OmniVoice asks for three to ten. Longer clips do not improve cloning and
#: slow every single synthesis call that has to encode them.
MIN_CLIP_S = 2.0
MAX_CLIP_S = 30.0
TARGET_SAMPLE_RATE = 24_000

_INDEX = "index.json"
_SLUG = re.compile(r"[^a-z0-9]+")


class VoiceError(Exception):
    pass


@dataclass
class VoiceClip:
    id: str
    name: str
    #: sha256 of the normalised audio. Part of the synthesis cache key.
    ref_hash: str
    duration_s: float
    created_at: str
    filename: str

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "ref_hash": self.ref_hash,
            "duration_s": round(self.duration_s, 2),
            "created_at": self.created_at,
            "filename": self.filename,
        }


@dataclass
class VoiceLibrary:
    root: Path
    _clips: dict[str, VoiceClip] = field(default_factory=dict)

    @classmethod
    def open(cls, root: Path | None = None) -> VoiceLibrary:
        root = root or (get_settings().data_dir / "voices")
        library = cls(root=root)
        library.reload()
        return library

    # -- persistence -------------------------------------------------------

    @property
    def _index_path(self) -> Path:
        return self.root / _INDEX

    def reload(self) -> None:
        self._clips = {}
        if not self._index_path.exists():
            return
        try:
            raw = json.loads(self._index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for entry in raw:
            try:
                clip = VoiceClip(**entry)
            except TypeError:
                continue
            if (self.root / clip.filename).exists():
                self._clips[clip.id] = clip

    def _save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self._index_path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps([c.to_json() for c in self._clips.values()], indent=2),
            encoding="utf-8",
        )
        tmp.replace(self._index_path)

    # -- reading -----------------------------------------------------------

    def all(self) -> list[VoiceClip]:
        return sorted(self._clips.values(), key=lambda c: c.name.lower())

    def get(self, clip_id: str) -> VoiceClip | None:
        return self._clips.get(clip_id)

    def path_for(self, clip: VoiceClip) -> Path:
        return self.root / clip.filename

    def by_hash(self, ref_hash: str) -> VoiceClip | None:
        return next((c for c in self._clips.values() if c.ref_hash == ref_hash), None)

    # -- writing -----------------------------------------------------------

    def add(self, name: str, data: bytes) -> VoiceClip:
        """Store an uploaded clip, normalised to mono at the model sample rate.

        Normalising on the way in means the hash identifies the audio the model
        will actually see, not the container it arrived in -- so the same
        recording uploaded as WAV and as MP3 keys identically instead of
        silently doubling the cache.
        """
        samples, sample_rate = self._decode(data)
        duration = len(samples) / TARGET_SAMPLE_RATE
        if duration < MIN_CLIP_S:
            raise VoiceError(
                f"Clip is {duration:.1f}s; at least {MIN_CLIP_S:.0f}s is needed to clone a voice."
            )
        if duration > MAX_CLIP_S:
            # Trim rather than reject: a longer recording is usable, and it is
            # kinder than making someone edit audio before they can try this.
            samples = samples[: int(MAX_CLIP_S * TARGET_SAMPLE_RATE)]
            duration = MAX_CLIP_S

        # Hash the encoded file, not the in-memory samples. The node verifies
        # an uploaded clip against the hash it was filed under, and it only
        # ever sees the file -- hashing samples there would mean decoding and
        # re-quantising, which cannot reproduce the same bytes. The pipeline
        # above is deterministic, so identical input still yields one hash.
        buffer = io.BytesIO()
        sf.write(buffer, samples, TARGET_SAMPLE_RATE, format="WAV", subtype="PCM_16")
        encoded = buffer.getvalue()

        ref_hash = hashlib.sha256(encoded).hexdigest()
        filename = f"{ref_hash[:16]}.wav"
        self.root.mkdir(parents=True, exist_ok=True)
        destination = self.root / filename
        if not destination.exists():
            destination.write_bytes(encoded)

        existing = self.by_hash(ref_hash)
        if existing is not None:
            # Same audio under a new name: keep one clip, adopt the new label.
            existing.name = name.strip() or existing.name
            self._save()
            return existing

        clip = VoiceClip(
            id=self._unique_id(name),
            name=name.strip() or "Untitled voice",
            ref_hash=ref_hash,
            duration_s=duration,
            created_at=datetime.now(UTC).isoformat(),
            filename=filename,
        )
        self._clips[clip.id] = clip
        self._save()
        return clip

    def remove(self, clip_id: str) -> bool:
        clip = self._clips.pop(clip_id, None)
        if clip is None:
            return False
        # Only delete the audio if no other voice points at the same bytes.
        if not self.by_hash(clip.ref_hash):
            (self.root / clip.filename).unlink(missing_ok=True)
        self._save()
        return True

    # -- helpers -----------------------------------------------------------

    def _unique_id(self, name: str) -> str:
        base = _SLUG.sub("-", name.strip().lower()).strip("-") or "voice"
        candidate = f"clip-{base}"[:48]
        if candidate not in self._clips:
            return candidate
        return f"{candidate}-{uuid.uuid4().hex[:4]}"

    @staticmethod
    def _decode(data: bytes) -> tuple[np.ndarray, int]:
        try:
            samples, sample_rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        except Exception as exc:
            raise VoiceError(
                "Could not read that audio. WAV, FLAC and OGG work; "
                "for MP3 or M4A, convert it first."
            ) from exc

        mono = samples.mean(axis=1).astype(np.float32)
        if sample_rate != TARGET_SAMPLE_RATE:
            # Linear resample. Reference clips are short and only ever feed a
            # speaker encoder, so the quality difference against a windowed
            # sinc filter is not audible in the cloned output.
            duration = len(mono) / sample_rate
            target_len = int(duration * TARGET_SAMPLE_RATE)
            if target_len < 1:
                raise VoiceError("That clip is too short to use.")
            mono = np.interp(
                np.linspace(0, len(mono) - 1, target_len, dtype=np.float64),
                np.arange(len(mono)),
                mono,
            ).astype(np.float32)

        peak = float(np.max(np.abs(mono))) if len(mono) else 0.0
        if peak < 1e-4:
            raise VoiceError("That clip appears to be silent.")
        # Normalise level so the hash is not sensitive to recording gain and
        # the speaker encoder sees a consistent input.
        mono = (mono / peak * 0.95).astype(np.float32)
        return mono, TARGET_SAMPLE_RATE


def resolve_reference(
    spec: ModelSpec, voice: str, library: VoiceLibrary | None = None
) -> ReferenceClip | None:
    """Pair a requested model with the voice the caller asked for.

    Every mismatch between the two is caught here, at the edge, rather than
    surfacing later as a puzzling error from a model that was never given what
    it needed. The case that actually bit: a cloned voice sent to Kokoro, which
    reported only that it had no such voice -- true, but it named neither the
    real problem nor the fix.

    Returns the clip to synthesize with, or None when the model uses its own
    built-in voices.
    """
    library = library or VoiceLibrary.open()

    if not spec.supports_cloning:
        if library.get(voice) is not None:
            raise VoiceError(
                f"{spec.label} cannot use a cloned voice. Choose one of its "
                f"built-in voices, or switch to a model that clones."
            )
        return None

    if not voice:
        raise VoiceError(
            f"{spec.label} has no built-in voices. Upload a reference clip and select it."
        )

    clip = library.get(voice)
    if clip is None:
        raise VoiceError(f"There is no voice clip called {voice!r}. It may have been deleted.")

    return ReferenceClip(
        path=library.path_for(clip),
        ref_hash=clip.ref_hash,
        # Clips carry no transcript today. The field exists because OmniVoice
        # can use one to improve cloning, and the worker already passes it
        # through when present.
        transcript=getattr(clip, "transcript", None),
    )

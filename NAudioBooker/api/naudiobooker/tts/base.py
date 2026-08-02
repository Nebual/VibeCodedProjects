"""The seam every text-to-speech engine plugs into.

Adding a backend must never require touching the pipeline, the routes or the
worker. That is the whole point of this module, and it is what makes the remote
GPU node in Phase 5 a new file rather than a refactor.

These methods are synchronous by design, which departs from the sketch in
PLAN.md. Local synthesis is CPU-bound work inside onnxruntime; wrapping it in
``async def`` would not yield to the event loop and would mislead callers into
awaiting something that actually blocks. FastAPI runs sync handlers on a
threadpool, and the Phase 3 worker manages its own concurrency, so nothing is
lost.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

import numpy as np


def unload_backend(backend: object) -> bool:
    """Ask a backend to free its model. True if anything was released."""
    fn = getattr(backend, "unload", None)
    return bool(fn()) if callable(fn) else False


def prepare_backend(backend: object) -> None:
    """Tell a backend a batch of work is about to start.

    The remote backend uses this to evict models from sibling nodes sharing a
    GPU, which has to happen before synthesis rather than during it.
    """
    fn = getattr(backend, "prepare", None)
    if callable(fn):
        fn()


def backend_idle_seconds(backend: object) -> float | None:
    """Seconds since the backend last synthesized, if it tracks that."""
    import time

    last = getattr(backend, "last_used_at", None)
    return None if last is None else time.monotonic() - last


class TTSError(Exception):
    """Synthesis failed for a reason the caller may want to report."""


class BackendUnavailable(TTSError):
    """The backend cannot run at all -- missing model, unreachable node."""


@dataclass(frozen=True)
class Voice:
    id: str
    label: str
    language: str
    gender: str | None = None
    #: Content hash of the reference clip, for a cloned voice. None for the
    #: fixed voices a model ships with. Part of the synthesis cache key.
    ref_hash: str | None = None

    @property
    def is_cloned(self) -> bool:
        return self.ref_hash is not None

    @property
    def sort_key(self) -> tuple[str, str]:
        return (self.language, self.label)


@dataclass(frozen=True)
class AudioChunk:
    """Mono float32 audio in [-1, 1]."""

    samples: np.ndarray
    sample_rate: int

    @property
    def duration_s(self) -> float:
        return len(self.samples) / self.sample_rate if self.sample_rate else 0.0


@dataclass(frozen=True)
class ReferenceClip:
    """A cloned voice's reference audio, as handed to a synthesiser."""

    path: Path
    ref_hash: str
    #: Transcript of the clip. OmniVoice can auto-transcribe with Whisper, but
    #: that runs per call, so supplying it once is markedly faster.
    transcript: str | None = None


@dataclass(frozen=True)
class ModelOptions:
    """Per-request knobs that change the audio without changing the model.

    A shared vocabulary rather than a per-backend bag: each backend reads the
    fields it understands and ignores the rest, so adding a knob for one model
    does not ripple through the others. They cannot live on the backend
    instance -- one instance serves every request, and the weights are too
    large to hold one per setting combination.

    Whatever is added here must appear in ``cache_token``. A knob that changes
    the audio but not the cache key would serve the previous setting's audio
    back forever, and the symptom -- a slider that appears to do nothing after
    the first try -- points nowhere near the cache.
    """

    #: Chatterbox. Higher is more dramatic, and also faster; 0.5 is neutral.
    exaggeration: float | None = None
    #: Chatterbox classifier-free guidance. Lower slows the pacing down, which
    #: is how you compensate for the speed-up that exaggeration brings.
    cfg_weight: float | None = None

    def cache_token(self) -> str:
        """Stable identity of these options, empty when nothing is set.

        Empty is load-bearing: chunk_key omits the field entirely in that case,
        so every key written before this existed still resolves. Sorted and
        fixed-precision so the same settings always produce the same token.
        """
        parts = [f"{name}={value:.4f}" for name, value in sorted(self.as_dict().items())]
        return ",".join(parts)

    def as_dict(self) -> dict[str, float]:
        """Only the knobs actually set, for sending over the wire."""
        return {
            name: value
            for name, value in (
                ("exaggeration", self.exaggeration),
                ("cfg_weight", self.cfg_weight),
            )
            if value is not None
        }

    @classmethod
    def from_dict(cls, data: dict[str, float] | None) -> ModelOptions:
        data = data or {}
        return cls(
            exaggeration=data.get("exaggeration"),
            cfg_weight=data.get("cfg_weight"),
        )


#: Shared by every call that does not tune anything, so the common path does
#: not allocate and `is NO_OPTIONS` is a cheap default check.
NO_OPTIONS = ModelOptions()


@dataclass(frozen=True)
class BackendHealth:
    available: bool
    detail: str


@runtime_checkable
class TTSBackend(Protocol):
    """A speech synthesiser.

    ``model_version`` is part of the synthesis cache key, so it must change
    whenever the produced audio would change -- a different checkpoint, a
    different quantisation. Getting this wrong serves stale audio after a model
    swap, which is far more confusing than a cache miss.
    """

    id: str
    model_version: str
    sample_rate: int
    #: Longest text this backend should be handed in one call. The chunker
    #: targets it; exceeding it risks truncation or degraded prosody.
    max_chars: int

    def voices(self) -> list[Voice]: ...

    def synthesize(
        self,
        text: str,
        voice: str,
        speed: float = 1.0,
        reference: ReferenceClip | None = None,
        options: ModelOptions = NO_OPTIONS,
    ) -> AudioChunk:
        """Speak ``text``.

        ``reference`` carries a cloned voice's audio, and ``options`` the
        per-request tuning knobs. Models that support neither ignore them
        rather than raising, so the caller does not have to know which kind of
        model it is holding.
        """
        ...

    def health(self) -> BackendHealth: ...

    # Optional, duck-typed rather than required, so a backend that holds no
    # meaningful resources need not implement them:
    #
    #   unload() -> bool     drop the loaded model and free its memory
    #   prepare() -> None    called before a batch of work begins
    #   last_used_at         monotonic timestamp of the last synthesis
    #
    # Use the module helpers below rather than calling them directly.

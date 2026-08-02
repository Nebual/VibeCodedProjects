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
from typing import Protocol, runtime_checkable

import numpy as np


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

    def synthesize(self, text: str, voice: str, speed: float = 1.0) -> AudioChunk: ...

    def health(self) -> BackendHealth: ...

"""Shared API response models."""

from typing import Literal

from pydantic import BaseModel, Field

from .config import Role, TTSBackendId


class SystemDeps(BaseModel):
    """External binaries the pipeline shells out to.

    Surfaced by /health because a missing espeak-ng produces bad pronunciation
    of out-of-dictionary words rather than a crash, which is a miserable thing
    to diagnose after a book has already rendered.
    """

    ffmpeg: bool
    espeak_ng: bool


class TTSStatus(BaseModel):
    """What the synthesis backend is actually doing, as opposed to configured.

    The two differ silently and often. A remote backend whose node is
    unreachable falls back to local CPU and everything keeps working, so the
    only symptom is a render taking hours longer than expected. ``active`` is
    the backend really serving requests; ``configured`` is what was asked for.
    """

    #: Where synthesis was asked to run: "local" or "remote".
    configured: TTSBackendId
    #: Which model was asked for, e.g. "kokoro", "chatterbox-original".
    model: str = "kokoro"
    active: str | None = None
    available: bool
    detail: str
    #: Execution provider, when the active backend is local onnxruntime.
    provider: str | None = None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    role: Role
    tts_backend: TTSBackendId
    deps: SystemDeps
    tts: TTSStatus | None = None
    #: .env files that were found and read. Empty is normal under Docker, where
    #: configuration arrives as environment variables instead. Reported because
    #: "my .env is ignored" and "my .env is wrong" look identical from outside
    #: and have entirely different fixes.
    env_files: list[str] = Field(default_factory=list)

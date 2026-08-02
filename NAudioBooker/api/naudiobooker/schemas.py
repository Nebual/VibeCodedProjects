"""Shared API response models."""

from typing import Literal

from pydantic import BaseModel

from .config import Role, TTSBackendId


class SystemDeps(BaseModel):
    """External binaries the pipeline shells out to.

    Surfaced by /health because a missing espeak-ng produces bad pronunciation
    of out-of-dictionary words rather than a crash, which is a miserable thing
    to diagnose after a book has already rendered.
    """

    ffmpeg: bool
    espeak_ng: bool


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    role: Role
    tts_backend: TTSBackendId
    deps: SystemDeps

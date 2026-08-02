"""Resolve the configured TTS backend.

One process holds one backend instance: the model weights are hundreds of
megabytes and the onnxruntime session is thread-safe, so rebuilding it per
request would be wasteful and slow.
"""

from __future__ import annotations

import threading

from ..config import Settings, get_settings
from .base import TTSBackend

_instances: dict[str, TTSBackend] = {}
_lock = threading.Lock()


def _build(settings: Settings) -> TTSBackend:
    backend = settings.tts_backend

    if backend == "kokoro":
        from .kokoro_local import KokoroLocalBackend

        return KokoroLocalBackend(settings)

    if backend == "remote":
        from .remote_http import RemoteHttpBackend

        remote = RemoteHttpBackend(settings)
        if not settings.remote_fallback_local:
            return remote

        # A desktop GPU box sleeps and reboots. Wrapping the remote in a
        # fallback means that costs a slower render rather than a dead job.
        from .fallback import FallbackBackend
        from .kokoro_local import KokoroLocalBackend

        return FallbackBackend(remote, KokoroLocalBackend(settings))

    if backend == "piper":
        raise NotImplementedError("the Piper backend is not implemented yet")

    raise ValueError(f"unknown TTS backend {backend!r}")


def get_backend(settings: Settings | None = None) -> TTSBackend:
    settings = settings or get_settings()
    key = f"{settings.tts_backend}:{settings.models_dir}:{settings.kokoro_model}"

    instance = _instances.get(key)
    if instance is not None:
        return instance

    with _lock:
        if key not in _instances:
            _instances[key] = _build(settings)
        return _instances[key]


def reset_backends() -> None:
    """Drop cached backends. For tests and for config changes."""
    with _lock:
        _instances.clear()

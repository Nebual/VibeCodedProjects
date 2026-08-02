"""Resolve a model id to a working backend.

One process holds one instance per model: the weights are hundreds of megabytes
and the sessions are thread-safe, so rebuilding per request would be wasteful.
"""

from __future__ import annotations

import threading

from ..config import Settings, get_settings
from .base import TTSBackend
from .models import ModelSpec, get_model

_instances: dict[tuple, TTSBackend] = {}
_lock = threading.Lock()


def _local_backend(settings: Settings, spec: ModelSpec) -> TTSBackend:
    """Build the in-process backend for a model family.

    Imported lazily and per family, because Chatterbox and OmniVoice cannot
    coexist in one environment -- Chatterbox pins transformers==5.2.0 and
    OmniVoice needs >=5.3.0. Importing both eagerly would make whichever is
    absent break the other.
    """
    if spec.family == "kokoro":
        from .kokoro_local import KokoroLocalBackend

        return KokoroLocalBackend(settings)

    if spec.family == "chatterbox":
        from .chatterbox_backend import ChatterboxBackend

        return ChatterboxBackend(settings)

    if spec.family == "omnivoice":
        from .omnivoice_backend import OmniVoiceBackend

        return OmniVoiceBackend(settings)

    raise ValueError(f"no backend for model family {spec.family!r}")


def _build(settings: Settings, model_id: str) -> TTSBackend:
    spec = get_model(model_id)

    if not settings.is_remote:
        return _local_backend(settings, spec)

    from .remote_http import RemoteHttpBackend

    remote = RemoteHttpBackend(
        settings,
        model_id=model_id,
        base_url=settings.node_url_for(model_id),
    )

    # Falling back to local CPU is a kindness for Kokoro and a trap for the
    # cloning models: they run tens of times slower there, so a node going
    # offline would turn a twenty minute render into a multi-day one while
    # reporting success. Better to fail and say why.
    if not settings.remote_fallback_local or not spec.cpu_viable:
        return remote

    from .fallback import FallbackBackend

    return FallbackBackend(remote, _local_backend(settings, spec))


def get_backend(settings: Settings | None = None, model_id: str | None = None) -> TTSBackend:
    settings = settings or get_settings()
    model_id = model_id or settings.tts_model
    key = (settings.tts_backend, model_id, str(settings.models_dir), settings.kokoro_model)

    instance = _instances.get(key)
    if instance is not None:
        return instance

    with _lock:
        if key not in _instances:
            _instances[key] = _build(settings, model_id)
        return _instances[key]


def reset_backends() -> None:
    """Drop cached backends. For tests and for config changes."""
    with _lock:
        _instances.clear()

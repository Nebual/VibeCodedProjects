"""Shared plumbing for the torch-based cloning backends.

Chatterbox and OmniVoice cannot share a Python environment -- Chatterbox pins
``transformers==5.2.0`` and OmniVoice requires ``>=5.3.0``, which the resolver
reports as flatly unsatisfiable. Each therefore runs in its own venv, or its
own worker-node container, and neither imports the other. This module holds
only what both need and what does not import either.
"""

from __future__ import annotations

import logging

from ..config import Settings
from .base import BackendUnavailable

log = logging.getLogger(__name__)


def resolve_device(settings: Settings) -> str:
    """Pick a torch device, honouring NAB_TTS_DEVICE.

    Refuses to silently use CPU when CUDA was explicitly requested. These
    models run 20-40x slower on CPU, so a silent downgrade turns a twenty
    minute render into an overnight one with nothing in the logs to say why.
    """
    try:
        import torch
    except ImportError as exc:  # pragma: no cover - dependency of the extras
        raise BackendUnavailable(
            "torch is not installed. Install this model's extra, e.g. "
            "`uv pip install '.[omnivoice]'`."
        ) from exc

    wanted = settings.tts_device
    has_cuda = torch.cuda.is_available()

    if wanted == "cuda":
        if not has_cuda:
            raise BackendUnavailable(
                "NAB_TTS_DEVICE=cuda but torch reports no CUDA device. "
                "Check the driver and that a CUDA build of torch is installed."
            )
        return "cuda"
    if wanted == "cpu":
        return "cpu"
    return "cuda" if has_cuda else "cpu"


def describe_device(device: str) -> str:
    if device != "cuda":
        return "cpu"
    try:
        import torch

        return f"cuda ({torch.cuda.get_device_name(0)})"
    except Exception:  # pragma: no cover - cosmetic only
        return "cuda"


def warn_if_cpu(model_label: str, device: str) -> None:
    if device == "cpu":
        log.warning(
            "%s is running on CPU. Expect roughly 20-40x slower synthesis than "
            "on a GPU; a full novel becomes an overnight job.",
            model_label,
        )

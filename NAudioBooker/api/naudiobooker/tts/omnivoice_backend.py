"""OmniVoice: zero-shot cloning, non-autoregressive.

The architectural reason to prefer this over an LLM-backbone cloning model for
audiobooks: it is a diffusion language model, not autoregressive, so it cannot
wander off mid-sentence, repeat a phrase or trail into silence the way
Chatterbox occasionally can. Over the ~20,000 chunks in a novel, "occasionally"
adds up, and nobody is listening while it renders.

Requires its own environment. OmniVoice needs transformers>=5.3 and Chatterbox
pins transformers==5.2.0, which the resolver reports as unsatisfiable, so the
two never share a venv or a container.
"""

from __future__ import annotations

import logging
import threading
import time

import numpy as np

from ..config import Settings
from .base import (
    NO_OPTIONS,
    AudioChunk,
    BackendHealth,
    BackendUnavailable,
    ModelOptions,
    ReferenceClip,
    TTSError,
    Voice,
)
from .torch_common import describe_device, resolve_device, warn_if_cpu

log = logging.getLogger(__name__)

REPO_ID = "k2-fsa/OmniVoice"
SAMPLE_RATE = 24_000

#: Diffusion iterations. The model's default; fewer is faster and rougher.
#: Exposed because it is the one knob that trades quality against speed, and
#: over a whole book that trade is worth being able to make.
DEFAULT_STEPS = 32

#: OmniVoice is not phoneme-limited the way Kokoro is, but very long inputs
#: still degrade prosody and cost more to redo on a cache miss.
MAX_CHARS = 400


def _explain(exc: Exception) -> str:
    """Add the fix to failures whose message describes only the symptom.

    Triton JIT-compiles its CUDA kernels the first time one runs, and shells
    out to a C compiler to build the launcher. A -runtime CUDA base image has
    none, so a node loads the model, reports itself healthy, and then fails on
    the first chunk with a message about a compiler and nothing about Docker.
    """
    message = str(exc)
    if "C compiler" in message or "triton.knobs.build" in message:
        return (
            f"{message} -- Triton needs a C compiler to build its CUDA kernels "
            "and the node image has none. Install one in the container with: "
            "apt-get update && apt-get install -y build-essential -- or "
            "rebuild the image, which now includes it."
        )
    return message


class OmniVoiceBackend:
    """Local OmniVoice synthesis. Thread-safe; the model loads on first use."""

    id = "omnivoice"
    sample_rate = SAMPLE_RATE
    max_chars = MAX_CHARS

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._model = None
        self._device: str | None = None
        self._steps = DEFAULT_STEPS
        self._lock = threading.Lock()
        #: Monotonic timestamp of the last synthesis; drives idle unloading.
        self.last_used_at: float | None = None
        # No quantisation variants to distinguish, but the step count changes
        # the audio, so it belongs in the identity the cache keys on.
        self.model_version = f"omnivoice-0.2/{REPO_ID}/steps{self._steps}"

    # -- model lifecycle ---------------------------------------------------

    def _load(self):
        if self._model is not None:
            return self._model

        with self._lock:
            if self._model is not None:
                return self._model

            try:
                import torch
                from omnivoice import OmniVoice
            except ImportError as exc:
                raise BackendUnavailable(
                    "omnivoice is not installed. It needs its own environment "
                    "because it conflicts with chatterbox-tts: "
                    "`uv pip install omnivoice`."
                ) from exc

            device = resolve_device(self._settings)
            warn_if_cpu("OmniVoice", device)
            log.info("loading OmniVoice on %s", describe_device(device))

            try:
                self._model = OmniVoice.from_pretrained(
                    REPO_ID,
                    device_map=device if device == "cpu" else "cuda:0",
                    # fp16 halves memory and is faster on any modern GPU, but
                    # is slow and sometimes unsupported on CPU.
                    dtype=torch.float16 if device == "cuda" else torch.float32,
                )
            except Exception as exc:
                log.exception("OmniVoice failed to load")
                raise BackendUnavailable(
                    f"could not load OmniVoice: {type(exc).__name__}: {exc}. "
                    "The full traceback is in the node log."
                ) from exc

            self._device = device
            return self._model

    # -- TTSBackend --------------------------------------------------------

    def voices(self) -> list[Voice]:
        """No built-in voices: every voice is a cloned reference clip.

        Returning an empty list rather than raising lets the UI say "upload a
        clip to use this model" instead of showing an error.
        """
        return []

    def synthesize(
        self,
        text: str,
        voice: str,
        speed: float = 1.0,
        reference: ReferenceClip | None = None,
        options: ModelOptions = NO_OPTIONS,
    ) -> AudioChunk:
        self.last_used_at = time.monotonic()
        text = text.strip()
        if not text:
            raise TTSError("nothing to synthesize")
        if reference is None:
            raise TTSError(
                "OmniVoice has no built-in voices; choose a cloned voice or "
                "upload a reference clip."
            )

        model = self._load()
        kwargs: dict = {
            "text": text,
            "ref_audio": str(reference.path),
            "num_step": self._steps,
        }
        # Supplying the transcript skips a Whisper pass per call. Without it
        # the model transcribes the clip every time, which dominates the cost
        # of a short chunk.
        if reference.transcript:
            kwargs["ref_text"] = reference.transcript
        if abs(speed - 1.0) > 1e-3:
            kwargs["speed"] = speed

        try:
            audio = model.generate(**kwargs)
        except Exception as exc:
            raise TTSError(f"OmniVoice failed on {len(text)} chars: {_explain(exc)}") from exc

        samples = np.asarray(audio[0] if isinstance(audio, list) else audio, dtype=np.float32)
        return AudioChunk(samples=samples, sample_rate=SAMPLE_RATE)

    # -- resource management ----------------------------------------------

    def unload(self) -> bool:
        """Drop the model and hand its VRAM back to the driver.

        empty_cache() is the part that matters: torch keeps freed blocks in its
        own caching allocator, so without it nvidia-smi still shows the memory
        as taken and the sibling node still cannot load.
        """
        with self._lock:
            if self._model is None:
                return False
            self._model = None
            device, self._device = self._device, None

        if device == "cuda":
            try:
                import gc

                import torch

                gc.collect()
                torch.cuda.empty_cache()
            except Exception:  # pragma: no cover - best effort
                log.exception("could not empty the CUDA cache")
        log.info("unloaded %s", self.id)
        return True

    def health(self) -> BackendHealth:
        try:
            import omnivoice  # noqa: F401
        except ImportError:
            return BackendHealth(available=False, detail="omnivoice is not installed")

        if self._model is None:
            return BackendHealth(available=True, detail=f"{REPO_ID} (not yet loaded)")
        return BackendHealth(
            available=True,
            detail=f"{REPO_ID} on {describe_device(self._device or 'cpu')}",
        )

    @property
    def provider(self) -> str | None:
        if self._device is None:
            return None
        return "CUDAExecutionProvider" if self._device == "cuda" else "CPUExecutionProvider"

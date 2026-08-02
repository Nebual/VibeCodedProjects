"""Chatterbox: zero-shot cloning with expressive controls.

The English 0.5B checkpoint, which remains the quality benchmark of the family
for English. Multilingual v3 is newer, but its improvements are in cross-
language voice identity and accent preservation, which buys nothing here.

Autoregressive, unlike Kokoro and OmniVoice. It can repeat a phrase or trail
off, rarely, and rarely over twenty thousand chunks is not never -- if that
shows up in practice the fix is an ASR round-trip check on each chunk.

Requires its own environment: Chatterbox pins transformers==5.2.0 while
OmniVoice needs >=5.3.0, which the resolver reports as unsatisfiable.
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

#: Resemble's stated defaults. Lower cfg with higher exaggeration gives a more
#: dramatic read; for a full audiobook the neutral setting wears better.
DEFAULT_EXAGGERATION = 0.5
DEFAULT_CFG_WEIGHT = 0.5

MAX_CHARS = 300


def _or_default(value: float | None, fallback: float) -> float:
    """Unset means "use Resemble's default", not zero.

    Worth spelling out because both knobs are meaningful at 0.0, so `value or
    fallback` would silently rewrite a deliberate 0 into 0.5.
    """
    return fallback if value is None else value


def _check_watermarker() -> None:
    """Catch the broken-watermarker install before it becomes a riddle.

    Chatterbox watermarks its output with resemble-perth, which imports
    pkg_resources. setuptools 81 deprecated that module and 83 removed it, and
    Python 3.12 venvs no longer bundle setuptools at all -- so the import
    fails, perth catches it and sets PerthImplicitWatermarker = None, and
    Chatterbox only falls over later trying to call it.

    The resulting "'NoneType' object is not callable" names neither perth nor
    setuptools nor pkg_resources, which makes it essentially unsearchable. The
    image pins setuptools<81 for this reason; the check stays because a
    container built before that pin fails exactly this way.
    """
    try:
        import perth
    except ImportError:
        return  # A build without the watermarker at all is not our problem.

    if getattr(perth, "PerthImplicitWatermarker", None) is None:
        raise BackendUnavailable(
            "Chatterbox's watermarker (resemble-perth) failed to import "
            "pkg_resources, so it is unusable and Chatterbox would fail with "
            "\"'NoneType' object is not callable\". Fix it in the node "
            "container with: uv pip install 'setuptools<81' -- or rebuild the "
            "image, which now pins it."
        )


class ChatterboxBackend:
    """Local Chatterbox synthesis. Thread-safe; the model loads on first use."""

    id = "chatterbox"
    max_chars = MAX_CHARS

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._model = None
        self._device: str | None = None
        self._lock = threading.Lock()
        #: Monotonic timestamp of the last synthesis; drives idle unloading.
        self.last_used_at: float | None = None
        self._sample_rate = 24_000  # replaced with model.sr once loaded
        # The expressive controls used to live here and be baked into
        # model_version. They are per-request now, so they travel in
        # ModelOptions and land in the cache key through its token instead --
        # one instance can then serve every setting without reloading.
        self.model_version = "chatterbox-original"

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    # -- model lifecycle ---------------------------------------------------

    def _load(self):
        if self._model is not None:
            return self._model

        with self._lock:
            if self._model is not None:
                return self._model

            try:
                from chatterbox.tts import ChatterboxTTS
            except ImportError as exc:
                raise BackendUnavailable(
                    "chatterbox-tts is not installed. It needs its own "
                    "environment because it conflicts with omnivoice: "
                    "`uv pip install chatterbox-tts`."
                ) from exc

            _check_watermarker()

            device = resolve_device(self._settings)
            warn_if_cpu("Chatterbox", device)
            log.info("loading Chatterbox on %s", describe_device(device))

            try:
                self._model = ChatterboxTTS.from_pretrained(device=device)
            except Exception as exc:
                # Log the traceback before flattening to a message. Model
                # loaders fail deep inside their own dependency stack, and a
                # bare str(exc) like "'NoneType' object is not callable" says
                # nothing at all about where or why.
                log.exception("Chatterbox failed to load")
                raise BackendUnavailable(
                    f"could not load Chatterbox: {type(exc).__name__}: {exc}. "
                    "The full traceback is in the node log."
                ) from exc

            self._device = device
            self._sample_rate = int(getattr(self._model, "sr", 24_000))
            return self._model

    # -- TTSBackend --------------------------------------------------------

    def voices(self) -> list[Voice]:
        """No built-in voices: every voice is a cloned reference clip."""
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
                "Chatterbox has no built-in voices; choose a cloned voice or "
                "upload a reference clip."
            )

        model = self._load()
        try:
            wav = model.generate(
                text,
                audio_prompt_path=str(reference.path),
                exaggeration=_or_default(options.exaggeration, DEFAULT_EXAGGERATION),
                cfg_weight=_or_default(options.cfg_weight, DEFAULT_CFG_WEIGHT),
            )
        except Exception as exc:
            raise TTSError(f"Chatterbox failed on {len(text)} chars: {exc}") from exc

        samples = self._to_mono_float32(wav)
        return AudioChunk(samples=samples, sample_rate=self._sample_rate)

    @staticmethod
    def _to_mono_float32(wav) -> np.ndarray:
        """Chatterbox returns a torch tensor, usually shaped (1, T)."""
        array = wav.detach().cpu().numpy() if hasattr(wav, "detach") else np.asarray(wav)
        array = np.asarray(array, dtype=np.float32)
        if array.ndim > 1:
            # (channels, samples) -> mono. Squeeze rather than average so a
            # leading batch dimension of 1 does not get treated as stereo.
            array = array.squeeze()
            if array.ndim > 1:
                array = array.mean(axis=0)
        return array

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
            import chatterbox  # noqa: F401
        except ImportError:
            return BackendHealth(available=False, detail="chatterbox-tts is not installed")

        if self._model is None:
            return BackendHealth(available=True, detail="chatterbox-original (not yet loaded)")
        return BackendHealth(
            available=True,
            detail=f"chatterbox-original on {describe_device(self._device or 'cpu')}",
        )

    @property
    def provider(self) -> str | None:
        if self._device is None:
            return None
        return "CUDAExecutionProvider" if self._device == "cuda" else "CPUExecutionProvider"

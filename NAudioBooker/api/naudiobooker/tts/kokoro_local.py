"""Kokoro-82M running locally through onnxruntime.

Apache-2.0, ~82M parameters, 24 kHz output. Chosen as the default because it is
the best quality-per-compute available and it is non-autoregressive: the same
text always produces the same audio, and it cannot hallucinate or drift partway
through a long book the way an LLM-based synthesiser can.
"""

from __future__ import annotations

import logging
import threading

from ..config import Settings
from .base import AudioChunk, BackendHealth, BackendUnavailable, TTSError, Voice

log = logging.getLogger(__name__)

#: Kokoro voice ids encode language and gender as a two-letter prefix, e.g.
#: "af_heart" is American English, female. Anything unrecognised falls through
#: as English so a new voice never disappears from the list entirely.
_LANGUAGES = {
    "a": ("en-us", "American English"),
    "b": ("en-gb", "British English"),
    "e": ("es", "Spanish"),
    "f": ("fr-fr", "French"),
    "h": ("hi", "Hindi"),
    "i": ("it", "Italian"),
    "j": ("ja", "Japanese"),
    "p": ("pt-br", "Brazilian Portuguese"),
    "z": ("cmn", "Mandarin"),
}
_GENDERS = {"f": "female", "m": "male"}

#: Kokoro's context is 512 phoneme tokens. Prose averages a little under one
#: token per character, so this leaves comfortable headroom rather than risking
#: silent truncation at the end of a chunk.
MAX_CHARS = 350


def _describe(voice_id: str) -> Voice:
    prefix, _, name = voice_id.partition("_")
    lang_code, lang_name = _LANGUAGES.get(prefix[:1], ("en-us", "English"))
    gender = _GENDERS.get(prefix[1:2] or "")

    label = name.replace("_", " ").title() or voice_id
    detail = ", ".join(x for x in (lang_name, gender) if x)
    return Voice(
        id=voice_id,
        label=f"{label} ({detail})" if detail else label,
        language=lang_code,
        gender=gender,
    )


class KokoroLocalBackend:
    """Local Kokoro synthesis. Thread-safe; the model loads on first use."""

    id = "kokoro"
    sample_rate = 24_000
    max_chars = MAX_CHARS

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._model_path = settings.models_dir / settings.kokoro_model
        self._voices_path = settings.models_dir / settings.kokoro_voices
        # The quantisation is part of the identity: int8 and fp32 produce
        # audibly different audio from the same text, so cached chunks from one
        # must never be served for the other.
        self.model_version = f"kokoro-1.0/{self._model_path.stem}"

        self._kokoro = None
        self._lock = threading.Lock()

    # -- model lifecycle ---------------------------------------------------

    def _load(self):
        """Load the model once, under a lock.

        Two requests arriving together would otherwise each build a session and
        each allocate the weights.
        """
        if self._kokoro is not None:
            return self._kokoro

        with self._lock:
            if self._kokoro is not None:
                return self._kokoro

            missing = [p for p in (self._model_path, self._voices_path) if not p.exists()]
            if missing:
                raise BackendUnavailable(
                    "Kokoro model files not found: "
                    + ", ".join(str(p) for p in missing)
                    + ". Download them from the kokoro-onnx GitHub releases."
                )

            try:
                import onnxruntime as ort
                from kokoro_onnx import Kokoro
            except ImportError as exc:  # pragma: no cover - dependency is declared
                raise BackendUnavailable(f"kokoro-onnx is not installed: {exc}") from exc

            # espeak logs "words count mismatch" on roughly 40% of ordinary
            # prose chunks. It sounds alarming and is not: listening tests
            # found no audible defect in the flagged audio, and synthesising
            # the same sentence with straight and curly apostrophes produced
            # byte-identical output while only one variant warned. Left at
            # WARNING it buries the log lines that do matter.
            logging.getLogger("phonemizer").setLevel(logging.ERROR)

            threads = self._settings.onnx_threads
            log.info(
                "loading Kokoro from %s (%s threads)",
                self._model_path,
                threads or "auto",
            )

            # Build the session ourselves rather than letting kokoro-onnx do it,
            # so thread count is configurable. Left to itself onnxruntime grabs
            # every core, which starves anything else sharing the machine for
            # throughput it cannot actually use.
            options = ort.SessionOptions()
            if threads > 0:
                options.intra_op_num_threads = threads
                options.inter_op_num_threads = 1
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

            providers = self._providers(ort)
            session = ort.InferenceSession(str(self._model_path), options, providers=providers)
            # Report what onnxruntime actually chose, not what was requested:
            # a missing CUDA runtime falls back silently, and a GPU node that
            # is quietly running on CPU is the kind of thing you discover from
            # a render taking nine hours.
            log.info("Kokoro running on %s", session.get_providers()[0])
            self._kokoro = Kokoro.from_session(session, str(self._voices_path))
            return self._kokoro

    def _providers(self, ort) -> list[str]:
        """Execution providers in preference order."""
        wanted = self._settings.tts_device
        available = ort.get_available_providers()

        if wanted == "cpu":
            return ["CPUExecutionProvider"]
        if wanted == "cuda":
            if "CUDAExecutionProvider" not in available:
                raise BackendUnavailable(
                    "NAB_TTS_DEVICE=cuda but onnxruntime has no CUDA provider. "
                    "Install onnxruntime-gpu instead of onnxruntime."
                )
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]

        if "CUDAExecutionProvider" in available:
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]
        return ["CPUExecutionProvider"]

    # -- TTSBackend --------------------------------------------------------

    def voices(self) -> list[Voice]:
        described = [_describe(v) for v in self._load().get_voices()]
        return sorted(described, key=lambda v: v.sort_key)

    def synthesize(self, text: str, voice: str, speed: float = 1.0) -> AudioChunk:
        text = text.strip()
        if not text:
            raise TTSError("nothing to synthesize")

        kokoro = self._load()
        lang = _describe(voice).language
        try:
            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
        except Exception as exc:
            raise TTSError(f"Kokoro failed on {len(text)} chars: {exc}") from exc

        return AudioChunk(samples=samples, sample_rate=sample_rate)

    def health(self) -> BackendHealth:
        missing = [p for p in (self._model_path, self._voices_path) if not p.exists()]
        if missing:
            return BackendHealth(
                available=False,
                detail=f"missing model files: {', '.join(p.name for p in missing)}",
            )
        return BackendHealth(
            available=True,
            detail=f"{self._model_path.name} ({'loaded' if self._kokoro else 'not yet loaded'})",
        )

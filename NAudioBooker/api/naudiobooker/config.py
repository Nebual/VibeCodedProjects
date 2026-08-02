"""Runtime configuration.

Every setting is overridable by environment variable with the ``NAB_`` prefix,
e.g. ``NAB_ROLE=worker-node``, ``NAB_TTS_BACKEND=remote``.
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_API_DIR = Path(__file__).resolve().parents[1]

#: The repo root in a checkout. Inside the container image the package sits at
#: /app with no repo above it, so fall back to the package directory there.
_PROJECT_ROOT = _API_DIR.parent if (_API_DIR.parent / "api").is_dir() else _API_DIR

Role = Literal["api", "worker", "worker-node"]
"""
api          -- serves HTTP, owns the database, dispatches jobs
worker       -- drains the job queue on the primary host (same filesystem)
worker-node  -- stateless remote synthesiser (the Windows/3070 box); exposes
                only /synthesize and /health, and touches no book state
"""

#: Where synthesis runs. Legacy model names are still accepted here and are
#: normalised below, so an existing .env with NAB_TTS_BACKEND=kokoro keeps
#: working.
TTSBackendId = Literal["local", "remote", "kokoro", "piper"]

_LEGACY_BACKENDS = {"kokoro": "kokoro", "piper": "piper"}

#: Env files consulted, in increasing order of precedence.
ENV_FILE_CANDIDATES = (_PROJECT_ROOT / ".env", _API_DIR / ".env", Path(".env"))


def env_files_found() -> list[str]:
    """Which of the candidate .env files actually exist.

    Surfaced by /health because "my .env is being ignored" is otherwise
    indistinguishable from "my .env is wrong", and the two have completely
    different fixes. Note that in Docker this list is usually empty and that is
    correct: Compose passes configuration as environment variables via
    `env_file:`, and a root .env never enters the container.
    """
    found = []
    for candidate in ENV_FILE_CANDIDATES:
        try:
            if candidate.is_file():
                found.append(str(candidate.resolve()))
        except OSError:
            continue
    return found


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NAB_",
        # Anchored to the project rather than the working directory. The API
        # starts with `cd api && uvicorn ...`, the worker likewise, and a bare
        # ".env" would therefore only ever be found when the process happened
        # to start from the right place -- so a .env at the repo root was
        # silently ignored and the app ran on defaults. Later entries win, so a
        # CWD-local .env can still override.
        env_file=ENV_FILE_CANDIDATES,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    role: Role = "api"

    # Storage. Everything the app generates lives under data_dir so a single
    # bind mount covers uploads, rendered audio, the chunk cache and the db.
    # Absolute for the same reason as env_file: a relative default resolves
    # against the working directory, so the same install would look in
    # different places depending on how it was launched.
    data_dir: Path = _PROJECT_ROOT / "data"

    # TTS. Two independent choices that used to be one field: which model, and
    # whether it runs here or on the node. Conflating them made "Chatterbox
    # Nano, locally" impossible to express.
    tts_backend: TTSBackendId = "local"
    tts_model: str = "kokoro"
    tts_voice: str = "af_heart"
    tts_speed: float = 1.0

    #: Languages offered in the voice picker. Kokoro ships 54 voices across
    #: nine languages, and the 26 non-English ones bury the useful ones in a
    #: dropdown. Set to an empty list to show everything.
    voice_languages: list[str] = Field(default_factory=lambda: ["en-us", "en-gb"])

    # Model weights. Kept outside data_dir because they are large, immutable
    # and shared between every book, so they should not be backed up or synced
    # alongside a user's library.
    models_dir: Path = _PROJECT_ROOT / "models"
    #: fp32, deliberately. The int8 build is a third of the size but measured
    #: 5x SLOWER on CPU on both machines tested -- quantised kernels lose badly
    #: to onnxruntime's optimised fp32 paths for this model's op mix.
    kokoro_model: str = "kokoro-v1.0.onnx"
    kokoro_voices: str = "voices-v1.0.bin"

    #: onnxruntime intra-op threads. Kokoro stops scaling past a handful of
    #: cores and gets slower once SMT siblings are used, so more is not better.
    #: Four leaves the machine usable for whatever else it hosts while giving
    #: up little throughput. 0 hands the choice to onnxruntime (all cores).
    onnx_threads: int = 4
    #: "auto" uses CUDA when onnxruntime-gpu is installed and a device is
    #: present, otherwise CPU. Force either way for troubleshooting.
    tts_device: Literal["auto", "cpu", "cuda"] = "auto"

    #: Unload the model after this many seconds idle, freeing its VRAM for a
    #: sibling node on the same card. Only worker-nodes do this; 0 disables it.
    #: Sixty seconds is short on purpose -- a reload costs seconds, whereas
    #: discovering the other model cannot start costs a failed render.
    idle_unload_s: float = 60.0

    # Worker
    #: How long the worker sleeps when the queue is empty.
    worker_poll_interval_s: float = 2.0

    #: Chunks synthesized at once within a chapter.
    #:
    #: Kokoro's ONNX graph is exported at a fixed batch of 1 -- the tokens
    #: input is literally [1, sequence_length] and the output has no batch
    #: axis -- so real batching is not available and overlapping separate
    #: calls is the only way to give the card more than one thing to do.
    #: Measured on an RTX 3070: one stream 45x real time, two streams ~40x
    #: each (~1.8x total), three streams ~25x each, which is no better than
    #: two. So two is the knee, and past it contention costs more than the
    #: extra parallelism wins.
    #:
    #: Defaults to 1. Raising it costs VRAM -- the weights are shared but
    #: activations are not -- which matters on a card already too small to
    #: hold two cloning models at once.
    render_concurrency: int = Field(default=1, ge=1, le=8)

    # Output encoding. Speech at 24 kHz mono needs far less than music: 96 kbps
    # MP3 is transparent for narration, and AAC holds up at a lower rate still.
    # (ACX submission would want 192 kbps CBR at 44.1 kHz -- these defaults are
    # for listening, not for delivery to a distributor.)
    mp3_bitrate: str = "96k"
    m4b_bitrate: str = "64k"
    #: Sample rate for the M4B. None follows the source, which is what you
    #: want: synthesis is 24 kHz and AAC encodes that natively, so upsampling
    #: adds no information and costs roughly 30% of the encode. Set it (44100)
    #: only for a player that insists.
    m4b_sample_rate: int | None = None

    # Remote GPU worker (Phase 5). When tts_backend is "remote" these must be
    # set; the dispatcher falls back to local synthesis if the node is
    # unreachable, so an unset/offline node degrades rather than fails.
    remote_worker_url: str | None = None
    #: Per-model node URLs, as {"omnivoice": "http://box:8002"}. Needed because
    #: Chatterbox and OmniVoice cannot share an environment, so each runs in its
    #: own container on its own port. Falls back to remote_worker_url.
    remote_model_urls: dict[str, str] = Field(default_factory=dict)
    remote_worker_token: str | None = None
    remote_worker_timeout_s: float = 120.0
    #: Fall back to local CPU synthesis when the node cannot be reached.
    #: Turn off only if you would rather a render fail than finish slowly.
    remote_fallback_local: bool = True

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    @property
    def books_dir(self) -> Path:
        return self.data_dir / "books"

    @property
    def cache_dir(self) -> Path:
        """Content-addressed synthesised chunks. See PLAN.md."""
        return self.data_dir / "cache"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "naudiobooker.db"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.books_dir, self.cache_dir):
            d.mkdir(parents=True, exist_ok=True)

    @model_validator(mode="after")
    def _normalise_legacy_backend(self) -> "Settings":
        """Accept the old NAB_TTS_BACKEND=<model> spelling.

        The field used to name a model. Someone's working .env should not stop
        working because the field was split in two.
        """
        legacy = _LEGACY_BACKENDS.get(self.tts_backend)
        if legacy is not None:
            self.tts_model = legacy
            self.tts_backend = "local"
        return self

    @property
    def is_remote(self) -> bool:
        return self.tts_backend == "remote"

    def node_url_for(self, model_id: str) -> str | None:
        """Which node serves this model, if any."""
        return self.remote_model_urls.get(model_id) or self.remote_worker_url


@lru_cache
def get_settings() -> Settings:
    return Settings()

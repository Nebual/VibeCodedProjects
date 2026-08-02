"""Synthesis on another machine, over HTTP.

The narrowest useful seam: text in, audio out. The node needs no filesystem
access, no database and no knowledge of books or jobs, which is why moving
synthesis to the GPU box is a new file rather than a refactor.
"""

from __future__ import annotations

import io
import logging
import threading

import httpx
import soundfile as sf

from ..config import Settings
from .base import AudioChunk, BackendHealth, BackendUnavailable, TTSError, Voice

log = logging.getLogger(__name__)


class RemoteHttpBackend:
    """Proxies synthesis to a ``role=worker-node`` instance."""

    id = "remote"

    def __init__(self, settings: Settings) -> None:
        if not settings.remote_worker_url:
            raise BackendUnavailable(
                "NAB_REMOTE_WORKER_URL is not set; the remote backend has nowhere to go"
            )
        self._base = settings.remote_worker_url.rstrip("/")
        self._token = settings.remote_worker_token
        self._timeout = settings.remote_worker_timeout_s

        # Filled in from the node on first contact. Defaults are placeholders
        # that must never reach a cache key, which is why _describe() raises
        # rather than guessing if the node cannot be reached.
        self._model_version: str | None = None
        self.sample_rate = 24_000
        self.max_chars = 350
        self._lock = threading.Lock()

        self._client = httpx.Client(
            base_url=self._base,
            timeout=self._timeout,
            headers={"Authorization": f"Bearer {self._token}"} if self._token else {},
        )

    # -- identity ----------------------------------------------------------

    @property
    def model_version(self) -> str:
        """The *remote* model's version, not a local guess.

        This lands in the chunk cache key, so it has to describe the model that
        actually produced the audio. Getting it right also means a chapter
        synthesized on the GPU box and one synthesized locally share cache
        entries when both run the same weights -- and correctly do not when
        they differ.
        """
        if self._model_version is None:
            self._describe()
        assert self._model_version is not None
        return self._model_version

    def _describe(self) -> None:
        with self._lock:
            if self._model_version is not None:
                return
            try:
                response = self._client.get("/node/health", timeout=10.0)
                response.raise_for_status()
                info = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise BackendUnavailable(f"cannot reach node at {self._base}: {exc}") from exc

            if not info.get("available"):
                raise BackendUnavailable(f"node at {self._base} is not ready: {info.get('detail')}")

            self._model_version = str(info["model_version"])
            self.sample_rate = int(info.get("sample_rate") or self.sample_rate)
            self.max_chars = int(info.get("max_chars") or self.max_chars)
            log.info(
                "remote node %s ready: %s @ %s Hz",
                self._base,
                self._model_version,
                self.sample_rate,
            )

    # -- TTSBackend --------------------------------------------------------

    def voices(self) -> list[Voice]:
        try:
            response = self._client.get("/voices", timeout=15.0)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise BackendUnavailable(f"cannot list voices on {self._base}: {exc}") from exc
        return [
            Voice(
                id=v["id"],
                label=v["label"],
                language=v["language"],
                gender=v.get("gender"),
            )
            for v in response.json()
        ]

    def synthesize(self, text: str, voice: str, speed: float = 1.0) -> AudioChunk:
        try:
            response = self._client.post(
                "/node/synthesize",
                json={"text": text, "voice": voice, "speed": speed},
            )
        except httpx.HTTPError as exc:
            # A transport failure is the node being down, which the dispatcher
            # can fall back from. A bad response is not.
            raise BackendUnavailable(f"node request failed: {exc}") from exc

        if response.status_code == 401:
            raise BackendUnavailable("node rejected the token")
        if response.status_code == 503:
            raise BackendUnavailable(f"node unavailable: {response.text[:200]}")
        if response.status_code >= 400:
            raise TTSError(f"node returned {response.status_code}: {response.text[:200]}")

        samples, sample_rate = sf.read(io.BytesIO(response.content), dtype="float32")
        return AudioChunk(samples=samples, sample_rate=sample_rate)

    def health(self) -> BackendHealth:
        try:
            response = self._client.get("/node/health", timeout=5.0)
            response.raise_for_status()
            info = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            return BackendHealth(available=False, detail=f"{self._base} unreachable: {exc}")

        return BackendHealth(
            available=bool(info.get("available")),
            detail=f"{self._base}: {info.get('detail', 'ok')}",
        )

    def close(self) -> None:
        self._client.close()

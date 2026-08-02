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
from .base import (
    AudioChunk,
    BackendHealth,
    BackendUnavailable,
    ReferenceClip,
    TTSError,
    Voice,
)

log = logging.getLogger(__name__)


class RemoteHttpBackend:
    """Proxies synthesis to a ``role=worker-node`` instance."""

    id = "remote"

    def __init__(
        self,
        settings: Settings,
        model_id: str | None = None,
        base_url: str | None = None,
    ) -> None:
        base_url = base_url or settings.remote_worker_url
        if not base_url:
            raise BackendUnavailable(
                "NAB_REMOTE_WORKER_URL is not set; the remote backend has nowhere to go"
            )
        self._settings = settings
        self._model_id = model_id or settings.tts_model
        self._base = base_url.rstrip("/")
        self._evicted = False
        #: Clips known to be on the node, so each is uploaded at most once.
        self._clips_on_node: set[str] = set()
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
        self._ensure_described()
        assert self._model_version is not None
        return self._model_version

    def _ensure_described(self) -> None:
        """Contact the node once, before anything depends on what it is.

        Cheap after the first call, and deliberately not left to whoever
        happens to read model_version first: the checks in _describe are the
        only thing standing between a misconfigured node and a render that
        quietly comes back in the wrong voice.
        """
        if self._model_version is None:
            self._describe()

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

            self._check_serves_the_right_model(info)

            self._model_version = str(info["model_version"])
            self.sample_rate = int(info.get("sample_rate") or self.sample_rate)
            self.max_chars = int(info.get("max_chars") or self.max_chars)
            log.info(
                "remote node %s ready: %s @ %s Hz",
                self._base,
                self._model_version,
                self.sample_rate,
            )

    def _check_serves_the_right_model(self, info: dict) -> None:
        """Refuse a node that runs a different model than the one asked for.

        node_url_for() falls back to NAB_REMOTE_WORKER_URL for any model with
        no entry in NAB_REMOTE_MODEL_URLS, so a missing entry silently points a
        cloning request at whichever node happens to be the default. The node
        would then fail somewhere deep in synthesis, or -- worse -- succeed and
        return audio from the wrong voice entirely.
        """
        from .models import ALL_MODELS, get_model

        served = str(info.get("backend") or "")
        expected = get_model(self._model_id).family

        # Only a node that names a family we recognise tells us anything. One
        # proxying onward reports "remote", and an unfamiliar id means a
        # backend this build has not heard of -- neither is evidence of a
        # mismatch, and refusing them would lock out more than it protects.
        if served not in {spec.family for spec in ALL_MODELS}:
            return

        if served != expected:
            raise BackendUnavailable(
                f"node at {self._base} runs {served!r}, but {self._model_id!r} "
                f"needs a node running {expected!r}. Point NAB_REMOTE_MODEL_URLS"
                f'["{self._model_id}"] at the right one.'
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

    # -- sharing one GPU between nodes -------------------------------------

    def _sibling_urls(self) -> list[str]:
        """Other nodes on the same host, which therefore share the card.

        Matched on hostname while ignoring the port: two containers on the same
        machine are exactly the case that contends for VRAM, and two nodes on
        different machines are exactly the case that must not be disturbed.
        """
        from urllib.parse import urlparse

        mine = urlparse(self._base)
        candidates = {
            *self._settings.remote_model_urls.values(),
            *([self._settings.remote_worker_url] if self._settings.remote_worker_url else []),
        }

        siblings = []
        for url in candidates:
            other = urlparse(url.rstrip("/"))
            if other.hostname == mine.hostname and other.port != mine.port:
                siblings.append(url.rstrip("/"))
        return sorted(set(siblings))

    def prepare(self) -> None:
        """Free the card before loading onto it.

        These models will not both fit in 8 GB, and the failure without this is
        an out-of-memory error naming the model that was *loading*, never the
        one still holding the memory. Done once per backend instance -- the
        siblings unload themselves after a minute idle anyway, so this only has
        to cover the handover.
        """
        if self._evicted:
            return
        self._evicted = True

        for url in self._sibling_urls():
            try:
                response = self._client.post(f"{url}/node/unload", timeout=20.0, json={})
                if response.status_code < 400:
                    freed = response.json().get("unloaded")
                    log.info(
                        "asked %s to unload before using %s: %s",
                        url,
                        self._base,
                        "freed" if freed else "nothing loaded",
                    )
            except (httpx.HTTPError, ValueError) as exc:
                # A sibling that is down cannot be holding the card, so this is
                # never a reason to fail.
                log.debug("could not reach sibling %s: %s", url, exc)

    def _push_clip(self, reference: ReferenceClip) -> None:
        """Upload a reference clip the node does not have yet."""
        try:
            data = reference.path.read_bytes()
        except OSError as exc:
            raise TTSError(f"cannot read reference clip {reference.path}: {exc}") from exc

        response = self._client.post(
            f"/node/clips/{reference.ref_hash}",
            content=data,
            headers={"Content-Type": "application/octet-stream"},
            timeout=60.0,
        )
        if response.status_code >= 400:
            raise TTSError(f"node rejected the reference clip: {response.text[:200]}")
        self._clips_on_node.add(reference.ref_hash)
        log.info("uploaded reference clip %s to %s", reference.ref_hash[:12], self._base)

    def _ensure_clip(self, reference: ReferenceClip) -> None:
        """Make sure the node holds this clip, uploading it at most once.

        Sending the clip with every chunk would be simpler and would move
        hundreds of megabytes per book to repeat the same few hundred kilobytes.
        """
        if reference.ref_hash in self._clips_on_node:
            return
        try:
            probe = self._client.get(f"/node/clips/{reference.ref_hash}", timeout=15.0)
            if probe.status_code < 400 and probe.json().get("present"):
                self._clips_on_node.add(reference.ref_hash)
                return
        except (httpx.HTTPError, ValueError):
            # Fall through and upload: a failed probe is not worth failing over
            # when the upload would answer the question anyway.
            pass
        self._push_clip(reference)

    def synthesize(
        self,
        text: str,
        voice: str,
        speed: float = 1.0,
        reference: ReferenceClip | None = None,
    ) -> AudioChunk:
        # Before anything is sent: confirm this node runs the model we think it
        # does. Preview reaches synthesize() without ever reading model_version,
        # so leaving the check to that property meant a preview sailed straight
        # past it and failed on the node with a message about a missing voice.
        self._ensure_described()
        self.prepare()
        if reference is not None:
            self._ensure_clip(reference)

        payload = {"text": text, "voice": voice, "speed": speed}
        if reference is not None:
            payload["voice_ref"] = reference.ref_hash
            payload["ref_text"] = reference.transcript

        try:
            response = self._client.post("/node/synthesize", json=payload)
            if response.status_code == 409 and reference is not None:
                # The node lost its clip cache -- a restart, or a wiped volume.
                # Re-upload and try once more rather than failing the render.
                log.info("node no longer has clip %s; re-uploading", reference.ref_hash[:12])
                self._clips_on_node.discard(reference.ref_hash)
                self._push_clip(reference)
                response = self._client.post("/node/synthesize", json=payload)
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

        # A node serving the wrong model is not healthy for this backend, even
        # though it is perfectly healthy in itself. Reported here so /health
        # names the misconfiguration instead of waiting for a render to fail.
        try:
            self._check_serves_the_right_model(info)
        except BackendUnavailable as exc:
            return BackendHealth(available=False, detail=str(exc))

        return BackendHealth(
            available=bool(info.get("available")),
            detail=f"{self._base}: {info.get('detail', 'ok')}",
        )

    def close(self) -> None:
        self._client.close()

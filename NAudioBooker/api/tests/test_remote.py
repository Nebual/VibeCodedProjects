"""Remote synthesis node, the HTTP client, and fallback behaviour.

The node is run in-process against a fake TTS backend and reached through a
real httpx transport, so the wire format is genuinely exercised -- WAV encode,
transfer, decode -- rather than mocked away. That round trip is where the bugs
would be.
"""

from __future__ import annotations

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
from test_tts import FakeBackend

from naudiobooker.config import Settings
from naudiobooker.main import create_app
from naudiobooker.tts.base import (
    AudioChunk,
    BackendHealth,
    BackendUnavailable,
    TTSError,
    Voice,
)
from naudiobooker.tts.fallback import FallbackBackend
from naudiobooker.tts.remote_http import RemoteHttpBackend


@pytest.fixture
def node(monkeypatch):
    """A worker-node app backed by the fake synthesiser."""
    settings = Settings(role="worker-node", tts_backend="kokoro")
    backend = FakeBackend()
    monkeypatch.setattr("naudiobooker.config.get_settings", lambda: settings)
    monkeypatch.setattr("naudiobooker.main.get_settings", lambda: settings)
    monkeypatch.setattr("naudiobooker.routes.node.get_settings", lambda: settings)
    monkeypatch.setattr("naudiobooker.routes.node.get_backend", lambda *a, **k: backend)
    monkeypatch.setattr("naudiobooker.routes.tts.get_backend", lambda *a, **k: backend)
    with TestClient(create_app()) as client:
        yield client, backend, settings


def remote_against(client: TestClient, **overrides) -> RemoteHttpBackend:
    """A RemoteHttpBackend whose HTTP calls land on the in-process node.

    Bridged through MockTransport rather than ASGITransport: the latter is
    async-only, and the backend is deliberately synchronous. Requests still go
    through the real app, so the WAV encode/transfer/decode round trip -- the
    part worth testing -- is genuine.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        response = client.request(
            request.method,
            request.url.path,
            content=request.content,
            headers={
                k: v
                for k, v in request.headers.items()
                if k.lower() in ("authorization", "content-type")
            },
        )
        return httpx.Response(
            response.status_code,
            content=response.content,
            headers={
                k: v
                for k, v in response.headers.items()
                if k.lower() in ("content-type", "x-audio-duration")
            },
        )

    settings = Settings(tts_backend="remote", remote_worker_url="http://node.test", **overrides)
    backend = RemoteHttpBackend(settings)
    backend._client = httpx.Client(
        transport=httpx.MockTransport(handler),
        base_url="http://node.test",
        headers=backend._client.headers,
    )
    return backend


# ---------------------------------------------------------------------------
# The node
# ---------------------------------------------------------------------------


def test_node_reports_its_model(node):
    client, backend, _ = node

    info = client.get("/node/health").json()

    assert info["available"] is True
    assert info["model_version"] == backend.model_version
    assert info["sample_rate"] == backend.sample_rate
    assert info["authenticated"] is False


def test_node_synthesizes_wav(node):
    client, _, _ = node

    res = client.post("/node/synthesize", json={"voice": "fk_ann", "text": "hello there"})

    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"
    assert res.content[:4] == b"RIFF"
    assert float(res.headers["X-Audio-Duration"]) > 0


def test_node_rejects_empty_text(node):
    client, _, _ = node

    assert client.post("/node/synthesize", json={"voice": "fk_ann", "text": " "}).status_code == 400


def test_node_holds_no_book_state(node):
    """The point of the role: a GPU box has no library to leak or corrupt."""
    client, _, _ = node

    assert client.get("/books").status_code == 404
    assert client.get("/jobs").status_code == 404


def test_node_requires_the_token_when_one_is_set(node, monkeypatch):
    client, _, settings = node
    monkeypatch.setattr(settings, "remote_worker_token", "s3cret")

    unauthorized = client.post("/node/synthesize", json={"voice": "fk_ann", "text": "hi"})
    wrong = client.post(
        "/node/synthesize",
        json={"voice": "fk_ann", "text": "hi"},
        headers={"Authorization": "Bearer nope"},
    )
    right = client.post(
        "/node/synthesize",
        json={"voice": "fk_ann", "text": "hi"},
        headers={"Authorization": "Bearer s3cret"},
    )

    assert unauthorized.status_code == 401
    assert wrong.status_code == 401
    assert right.status_code == 200
    assert client.get("/node/health").json()["authenticated"] is True


# ---------------------------------------------------------------------------
# The client
# ---------------------------------------------------------------------------


def test_remote_round_trips_audio(node):
    client, fake, _ = node
    remote = remote_against(client)

    chunk = remote.synthesize("some words to speak", "fk_ann")

    assert chunk.sample_rate == fake.sample_rate
    assert len(chunk.samples) > 0
    assert chunk.samples.dtype == np.float32
    assert fake.calls[-1][0] == "some words to speak"


def test_remote_adopts_the_nodes_model_version(node):
    """The cache key must name the model that made the audio, not a guess."""
    client, fake, _ = node
    remote = remote_against(client)

    assert remote.model_version == fake.model_version
    assert remote.sample_rate == fake.sample_rate
    assert remote.max_chars == fake.max_chars


def test_remote_lists_voices_from_the_node(node):
    client, _, _ = node

    assert [v.id for v in remote_against(client).voices()] == ["fk_ann", "fk_bob"]


def test_unreachable_node_is_reported_as_unavailable():
    settings = Settings(tts_backend="remote", remote_worker_url="http://127.0.0.1:9")
    remote = RemoteHttpBackend(settings)

    assert not remote.health().available
    with pytest.raises(BackendUnavailable):
        remote.synthesize("hello", "fk_ann")


def test_missing_url_fails_loudly():
    with pytest.raises(BackendUnavailable, match="REMOTE_WORKER_URL"):
        RemoteHttpBackend(Settings(tts_backend="remote"))


# ---------------------------------------------------------------------------
# Fallback
# ---------------------------------------------------------------------------


class DeadBackend:
    """A node that is switched off."""

    id = "dead"
    model_version = "dead-1"
    sample_rate = 24_000
    max_chars = 350

    def __init__(self) -> None:
        self.attempts = 0

    def voices(self) -> list[Voice]:
        self.attempts += 1
        raise BackendUnavailable("box is asleep")

    def synthesize(self, text: str, voice: str, speed: float = 1.0) -> AudioChunk:
        self.attempts += 1
        raise BackendUnavailable("box is asleep")

    def health(self) -> BackendHealth:
        return BackendHealth(available=False, detail="asleep")


def test_falls_back_when_the_node_is_down():
    dead, local = DeadBackend(), FakeBackend()
    dispatcher = FallbackBackend(dead, local)

    chunk = dispatcher.synthesize("hello", "fk_ann")

    assert len(chunk.samples) > 0
    assert len(local.calls) == 1
    assert dispatcher.id == local.id


def test_a_downed_node_is_not_retried_on_every_chunk():
    """Otherwise every chunk pays a connection timeout before falling back."""
    dead, local = DeadBackend(), FakeBackend()
    dispatcher = FallbackBackend(dead, local, retry_after_s=300)

    for _ in range(5):
        dispatcher.synthesize("hello", "fk_ann")

    assert dead.attempts == 1
    assert len(local.calls) == 5


def test_node_is_retried_once_the_cooldown_expires():
    dead, local = DeadBackend(), FakeBackend()
    dispatcher = FallbackBackend(dead, local, retry_after_s=0.0)

    dispatcher.synthesize("one", "fk_ann")
    dispatcher.synthesize("two", "fk_ann")

    assert dead.attempts == 2  # tried again rather than written off


def test_recovered_node_takes_over_again(node):
    client, remote_fake, _ = node
    local = FakeBackend()
    dispatcher = FallbackBackend(remote_against(client), local, retry_after_s=0.0)

    dispatcher.synthesize("via remote", "fk_ann")

    assert remote_fake.calls and not local.calls
    assert dispatcher.id == "remote"


def test_model_version_follows_the_active_backend():
    """A fallback must not serve one model's audio under another's cache key."""
    dead, local = DeadBackend(), FakeBackend()
    dispatcher = FallbackBackend(dead, local)

    dispatcher.synthesize("hello", "fk_ann")

    assert dispatcher.model_version == local.model_version


def test_input_errors_are_not_retried_locally(node):
    """A node rejecting bad input is working correctly; retrying repeats it."""
    client, fake, _ = node
    local = FakeBackend()
    dispatcher = FallbackBackend(remote_against(client), local)

    with pytest.raises(TTSError):
        dispatcher.synthesize("   ", "fk_ann")

    assert not local.calls

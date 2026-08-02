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
    NO_OPTIONS,
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

    def synthesize(
        self, text: str, voice: str, speed: float = 1.0, reference=None, options=NO_OPTIONS
    ) -> AudioChunk:
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


# ---------------------------------------------------------------------------
# Reference clip transfer
# ---------------------------------------------------------------------------


@pytest.fixture
def clip_node(monkeypatch, tmp_path):
    """A node whose clip cache lives in a temp directory."""
    settings = Settings(
        role="worker-node", data_dir=tmp_path / "nodedata", idle_unload_s=0, _env_file=None
    )
    backend = FakeBackend()
    for target in (
        "naudiobooker.config",
        "naudiobooker.main",
        "naudiobooker.routes.node",
        "naudiobooker.node_clips",
    ):
        monkeypatch.setattr(f"{target}.get_settings", lambda: settings, raising=False)
    monkeypatch.setattr("naudiobooker.routes.node.get_backend", lambda *a, **k: backend)
    with TestClient(create_app()) as client:
        yield client, backend, settings


def make_clip(tmp_path):
    """A reference clip on disk, named by the hash of its own bytes."""
    import hashlib

    import numpy as np
    import soundfile as sf

    from naudiobooker.tts.base import ReferenceClip

    t = np.arange(24_000 * 3, dtype=np.float32) / 24_000
    path = tmp_path / "ref.wav"
    sf.write(path, np.sin(2 * np.pi * 200 * t) * 0.5, 24_000, subtype="PCM_16")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return ReferenceClip(path=path, ref_hash=digest, transcript="a spoken line")


def test_clip_is_uploaded_once_not_per_chunk(clip_node, tmp_path):
    """A book is 20,000 chunks; resending the clip each time moves gigabytes."""
    client, fake, _ = clip_node
    clip = make_clip(tmp_path)
    backend = remote_against(client)

    uploads = []
    original = backend._push_clip
    backend._push_clip = lambda ref: (uploads.append(ref.ref_hash), original(ref))[1]

    for _ in range(5):
        backend.synthesize("some words", "clip-x", reference=clip)

    assert len(uploads) == 1
    assert len(fake.calls) == 5
    # The clip reached the backend on every call, not just the first.
    assert all(r is not None for r in fake.references)


def test_node_stores_and_reports_the_clip(clip_node, tmp_path):
    client, _, _ = clip_node
    clip = make_clip(tmp_path)

    before = client.get(f"/node/clips/{clip.ref_hash}").json()
    client.post(f"/node/clips/{clip.ref_hash}", content=clip.path.read_bytes())
    after = client.get(f"/node/clips/{clip.ref_hash}").json()

    assert before["present"] is False
    assert after["present"] is True


def test_node_rejects_a_clip_that_does_not_match_its_hash(clip_node, tmp_path):
    """Otherwise a clip filed under the wrong hash poisons every cached chunk."""
    client, _, _ = clip_node
    clip = make_clip(tmp_path)

    res = client.post(f"/node/clips/{clip.ref_hash}", content=b"different audio entirely")

    assert res.status_code == 400
    assert "does not match" in res.json()["detail"]


def test_node_rejects_a_hash_that_is_not_hex(clip_node):
    """The hash becomes a filename, so it never reaches the disk unvalidated."""
    client, _, _ = clip_node

    res = client.post("/node/clips/..%2F..%2Fescape", content=b"x")

    assert res.status_code in (400, 404)


def test_synthesis_without_the_clip_present_asks_for_it(clip_node, tmp_path):
    client, _, _ = clip_node
    clip = make_clip(tmp_path)

    res = client.post(
        "/node/synthesize",
        json={"voice": "clip-x", "text": "hello", "voice_ref": clip.ref_hash},
    )

    assert res.status_code == 409
    assert "not on this node" in res.json()["detail"]


def test_client_recovers_when_the_node_loses_its_clip(clip_node, tmp_path):
    """A node restart or wiped volume must not fail a render in progress."""
    client, fake, settings = clip_node
    clip = make_clip(tmp_path)
    backend = remote_against(client)

    backend.synthesize("first", "clip-x", reference=clip)

    # Simulate the node losing its cache while the client still believes it.
    for stored in (settings.data_dir / "node-clips").glob("*.wav"):
        stored.unlink()

    chunk = backend.synthesize("second", "clip-x", reference=clip)

    assert len(chunk.samples) > 0
    assert len(fake.calls) == 2


# ---------------------------------------------------------------------------
# Routing a model to the node that actually serves it
# ---------------------------------------------------------------------------


def _node_reporting(backend_id: str) -> httpx.MockTransport:
    """A node that claims to be running `backend_id`."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "available": True,
                "detail": "ok",
                "backend": backend_id,
                "model_version": f"{backend_id}-1",
                "sample_rate": 24_000,
                "max_chars": 300,
            },
        )

    return httpx.MockTransport(handler)


def _remote_for(model_id: str, backend_id: str) -> RemoteHttpBackend:
    settings = Settings(tts_backend="remote", remote_worker_url="http://node.test")
    remote = RemoteHttpBackend(settings, model_id=model_id, base_url="http://node.test")
    remote._client = httpx.Client(
        base_url="http://node.test", transport=_node_reporting(backend_id)
    )
    return remote


def test_remote_refuses_a_node_running_a_different_model() -> None:
    """node_url_for() falls back to the shared NAB_REMOTE_WORKER_URL for any
    model without its own entry, so a missing entry aims a cloning request at
    whichever node is the default -- silently, and with a puzzling failure
    much later."""
    remote = _remote_for("chatterbox-original", "kokoro")

    with pytest.raises(BackendUnavailable) as excinfo:
        _ = remote.model_version

    message = str(excinfo.value)
    assert "kokoro" in message and "chatterbox" in message
    # The message must name the setting to change, not just the disagreement.
    assert "NAB_REMOTE_MODEL_URLS" in message


def test_remote_accepts_a_node_running_the_right_model() -> None:
    assert _remote_for("chatterbox-original", "chatterbox").model_version == "chatterbox-1"


def test_remote_accepts_a_node_whose_backend_it_does_not_recognise() -> None:
    """An unfamiliar id is not evidence of a mismatch: a node proxying onward
    reports "remote", and a newer node may run a backend this build predates."""
    assert _remote_for("kokoro", "remote").model_version == "remote-1"
    assert _remote_for("kokoro", "some-future-model").model_version == "some-future-model-1"


def test_remote_refuses_the_wrong_node_before_synthesizing() -> None:
    """The check has to sit on the synthesis path, not only on model_version.

    Preview calls synthesize() directly and never reads model_version, so a
    guard that lived only there let a Chatterbox preview reach a Kokoro node --
    which failed with "voice not found", pointing at the voice rather than at
    the routing.
    """
    remote = _remote_for("chatterbox-original", "kokoro")

    with pytest.raises(BackendUnavailable, match="NAB_REMOTE_MODEL_URLS"):
        remote.synthesize("some words", "clip-narrator")


def test_health_reports_a_node_serving_the_wrong_model() -> None:
    health = _remote_for("omnivoice", "kokoro").health()

    assert health.available is False
    assert "NAB_REMOTE_MODEL_URLS" in health.detail


def test_concurrent_synthesis_evicts_siblings_only_once() -> None:
    """The worker can have several chunks in flight; eviction must stay once.

    Without a lock around the check-then-set, every in-flight chunk decides it
    is the first and fires its own round of unload requests at the siblings.
    """
    import threading

    unloads = []
    settings = Settings(
        tts_backend="remote",
        remote_worker_url="http://box:8001",
        remote_model_urls={"kokoro": "http://box:8001", "omnivoice": "http://box:8002"},
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/node/unload"):
            unloads.append(str(request.url))
            return httpx.Response(200, json={"unloaded": True})
        return httpx.Response(200, json={"unloaded": False})

    remote = RemoteHttpBackend(settings, model_id="kokoro", base_url="http://box:8001")
    remote._client = httpx.Client(
        base_url="http://box:8001", transport=httpx.MockTransport(handler)
    )

    start = threading.Event()

    def call() -> None:
        start.wait()
        remote.prepare()

    threads = [threading.Thread(target=call) for _ in range(8)]
    for t in threads:
        t.start()
    start.set()
    for t in threads:
        t.join()

    assert len(unloads) == 1, f"sibling evicted {len(unloads)} times"

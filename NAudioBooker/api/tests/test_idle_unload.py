"""Freeing VRAM: idle unloading, and evicting a sibling that shares the card."""

from __future__ import annotations

import time

import httpx
import pytest
from fastapi.testclient import TestClient
from test_tts import FakeBackend

from naudiobooker.config import Settings
from naudiobooker.main import create_app
from naudiobooker.tts.base import backend_idle_seconds, unload_backend
from naudiobooker.tts.idle import IdleUnloader
from naudiobooker.tts.remote_http import RemoteHttpBackend


class LoadableBackend(FakeBackend):
    """A fake that models the load/unload lifecycle."""

    def __init__(self) -> None:
        super().__init__()
        self.loaded = False
        self.last_used_at: float | None = None
        self.unload_calls = 0

    def synthesize(self, text, voice, speed=1.0, reference=None):
        self.loaded = True
        self.last_used_at = time.monotonic()
        return super().synthesize(text, voice, speed)

    def unload(self) -> bool:
        self.unload_calls += 1
        if not self.loaded:
            return False
        self.loaded = False
        return True


# ---------------------------------------------------------------------------
# unload()
# ---------------------------------------------------------------------------


def test_unload_reports_whether_anything_was_freed():
    backend = LoadableBackend()

    assert unload_backend(backend) is False  # nothing loaded yet

    backend.synthesize("hello", "fk_ann")
    assert unload_backend(backend) is True
    assert unload_backend(backend) is False  # already released


def test_unload_on_a_backend_that_does_not_support_it():
    """Never raise: callers should not have to know which kind they hold."""
    assert unload_backend(FakeBackend()) is False


def test_idle_seconds_is_none_before_first_use():
    assert backend_idle_seconds(LoadableBackend()) is None
    assert backend_idle_seconds(object()) is None


# ---------------------------------------------------------------------------
# The idle reaper
# ---------------------------------------------------------------------------


def test_idle_unloader_releases_after_the_deadline(monkeypatch):
    monkeypatch.setattr("naudiobooker.tts.idle.CHECK_INTERVAL_S", 0.05)
    backend = LoadableBackend()
    backend.synthesize("hello", "fk_ann")

    unloader = IdleUnloader(backend, idle_after_s=0.15)
    unloader.start()
    try:
        deadline = time.monotonic() + 3.0
        while backend.loaded and time.monotonic() < deadline:
            time.sleep(0.05)
    finally:
        unloader.stop()

    assert not backend.loaded


def test_idle_unloader_leaves_a_busy_backend_alone(monkeypatch):
    monkeypatch.setattr("naudiobooker.tts.idle.CHECK_INTERVAL_S", 0.05)
    backend = LoadableBackend()

    unloader = IdleUnloader(backend, idle_after_s=1.0)
    unloader.start()
    try:
        # Keep using it well inside the idle window.
        for _ in range(6):
            backend.synthesize("hello", "fk_ann")
            time.sleep(0.08)
    finally:
        unloader.stop()

    assert backend.loaded


def test_idle_unloading_can_be_disabled():
    backend = LoadableBackend()
    backend.synthesize("hello", "fk_ann")

    unloader = IdleUnloader(backend, idle_after_s=0)
    unloader.start()
    time.sleep(0.2)
    unloader.stop()

    assert backend.loaded


# ---------------------------------------------------------------------------
# The node endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def node(monkeypatch):
    settings = Settings(role="worker-node", idle_unload_s=0, _env_file=None)
    backend = LoadableBackend()
    for target in ("naudiobooker.config", "naudiobooker.main", "naudiobooker.routes.node"):
        monkeypatch.setattr(f"{target}.get_settings", lambda: settings, raising=False)
    monkeypatch.setattr("naudiobooker.routes.node.get_backend", lambda *a, **k: backend)
    with TestClient(create_app()) as client:
        yield client, backend, settings


def test_node_unload_endpoint(node):
    client, backend, _ = node
    backend.synthesize("hello", "fk_ann")

    first = client.post("/node/unload").json()
    second = client.post("/node/unload").json()

    assert first == {"unloaded": True, "detail": "model released"}
    assert second["unloaded"] is False


def test_node_unload_requires_the_token(node, monkeypatch):
    client, _, settings = node
    monkeypatch.setattr(settings, "remote_worker_token", "s3cret")

    assert client.post("/node/unload").status_code == 401
    assert client.post(
        "/node/unload", headers={"Authorization": "Bearer s3cret"}
    ).status_code == 200


# ---------------------------------------------------------------------------
# Sibling eviction
# ---------------------------------------------------------------------------


def remote(urls: dict[str, str], base: str, model: str = "omnivoice") -> RemoteHttpBackend:
    settings = Settings(
        tts_backend="remote",
        remote_worker_url="http://gpu-box:8001",
        remote_model_urls=urls,
        _env_file=None,
    )
    return RemoteHttpBackend(settings, model_id=model, base_url=base)


def test_siblings_are_other_ports_on_the_same_host():
    backend = remote(
        {
            "omnivoice": "http://gpu-box:8002",
            "chatterbox-original": "http://gpu-box:8003",
        },
        base="http://gpu-box:8002",
    )

    # The Kokoro node on :8001 shares the card too, so it counts.
    assert backend._sibling_urls() == ["http://gpu-box:8001", "http://gpu-box:8003"]


def test_a_node_on_another_host_is_not_a_sibling():
    """It has its own GPU; unloading it would be pure vandalism."""
    backend = remote(
        {"omnivoice": "http://gpu-box:8002", "chatterbox-original": "http://other-box:8003"},
        base="http://gpu-box:8002",
    )

    assert "http://other-box:8003" not in backend._sibling_urls()


def test_a_backend_is_not_its_own_sibling():
    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")

    assert "http://gpu-box:8002" not in backend._sibling_urls()


def test_prepare_asks_siblings_to_unload_once():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json={"unloaded": True})

    backend = remote(
        {"omnivoice": "http://gpu-box:8002", "chatterbox-original": "http://gpu-box:8003"},
        base="http://gpu-box:8002",
    )
    backend._client = httpx.Client(transport=httpx.MockTransport(handler))

    backend.prepare()
    backend.prepare()
    backend.prepare()

    # Once per sibling, not once per call -- and certainly not once per chunk.
    assert sorted(calls) == [
        "http://gpu-box:8001/node/unload",
        "http://gpu-box:8003/node/unload",
    ]


def test_an_unreachable_sibling_is_not_an_error():
    """A node that is down cannot be holding the card."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")
    backend._client = httpx.Client(transport=httpx.MockTransport(handler))

    backend.prepare()  # must not raise

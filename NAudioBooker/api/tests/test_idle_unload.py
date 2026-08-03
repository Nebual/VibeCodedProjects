"""Freeing VRAM: idle unloading, and evicting a sibling that shares the card."""

from __future__ import annotations

import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from test_tts import FakeBackend

from naudiobooker.config import Settings
from naudiobooker.main import create_app
from naudiobooker.tts.base import NO_OPTIONS, backend_idle_seconds, unload_backend
from naudiobooker.tts.idle import IdleUnloader
from naudiobooker.tts.remote_http import RemoteHttpBackend


class LoadableBackend(FakeBackend):
    """A fake that models the load/unload lifecycle."""

    def __init__(self) -> None:
        super().__init__()
        self.loaded = False
        self.last_used_at: float | None = None
        self.unload_calls = 0

    def synthesize(self, text, voice, speed=1.0, reference=None, options=NO_OPTIONS):
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
    assert (
        client.post("/node/unload", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    )


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


def _node(loaded: bool, calls: list[str]):
    """A transport standing in for the node and its siblings."""

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url.path == "/node/health":
            return httpx.Response(200, json={"available": True, "loaded": loaded})
        return httpx.Response(200, json={"unloaded": True})

    return httpx.MockTransport(handler)


def _unloads(calls: list[str]) -> list[str]:
    return sorted(c for c in calls if c.endswith("/node/unload"))


def test_prepare_evicts_siblings_when_the_node_is_cold():
    calls: list[str] = []
    backend = remote(
        {"omnivoice": "http://gpu-box:8002", "chatterbox-original": "http://gpu-box:8003"},
        base="http://gpu-box:8002",
    )
    backend._client = httpx.Client(
        base_url="http://gpu-box:8002",
        transport=_node(loaded=False, calls=calls),
    )

    backend.prepare()

    assert _unloads(calls) == [
        "http://gpu-box:8001/node/unload",
        "http://gpu-box:8003/node/unload",
    ]


def test_a_warm_node_needs_no_eviction():
    """Nothing has to be freed for a model that is already resident.

    This is what makes a ten minute idle window affordable: coming back to a
    still-loaded node costs one health check, not an unload of its siblings
    and a reload of itself.
    """
    calls: list[str] = []
    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")
    backend._client = httpx.Client(
        base_url="http://gpu-box:8002",
        transport=_node(loaded=True, calls=calls),
    )

    backend.prepare()

    assert _unloads(calls) == []


def test_repeated_prepares_do_not_re_check_the_node():
    """A render calls prepare once per chunk; it must not cost a round trip."""
    calls: list[str] = []
    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")
    backend._client = httpx.Client(
        base_url="http://gpu-box:8002",
        transport=_node(loaded=False, calls=calls),
    )

    for _ in range(5):
        backend.prepare()

    assert sum(1 for c in calls if c.endswith("/node/health")) == 1
    assert len(_unloads(calls)) == 1


def test_eviction_happens_again_after_the_card_may_have_changed_hands():
    """The bug a ten minute idle window would otherwise have introduced.

    Eviction used to fire once per backend instance, on the reasoning that a
    sibling unloads itself within a minute anyway. Use A, then B, then A again
    inside a ten minute window and A had already spent its one eviction while
    B still held the card -- an out-of-memory error naming the wrong model.
    """
    calls: list[str] = []
    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")
    backend._client = httpx.Client(
        base_url="http://gpu-box:8002",
        transport=_node(loaded=False, calls=calls),
    )

    backend.prepare()
    assert len(_unloads(calls)) == 1

    # A sibling ran in the meantime, so this node is cold again.
    backend._card_held_until = 0.0
    backend.prepare()

    assert len(_unloads(calls)) == 2, "the second visit did not free the card"


def test_concurrent_prepares_evict_once():
    """Several chunks in flight must not each fire their own round of unloads."""
    calls: list[str] = []
    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")
    backend._client = httpx.Client(
        base_url="http://gpu-box:8002",
        transport=_node(loaded=False, calls=calls),
    )

    start = threading.Event()

    def call() -> None:
        start.wait()
        backend.prepare()

    workers = [threading.Thread(target=call) for _ in range(8)]
    for w in workers:
        w.start()
    start.set()
    for w in workers:
        w.join()

    assert len(_unloads(calls)) == 1, f"evicted {len(_unloads(calls))} times"


def test_an_unreachable_sibling_is_not_an_error():
    """A node that is down cannot be holding the card."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")
    backend._client = httpx.Client(transport=httpx.MockTransport(handler))

    backend.prepare()  # must not raise


# ---------------------------------------------------------------------------
# Warming, and the timeout it exists to avoid
# ---------------------------------------------------------------------------


def _warming_node(calls: list[str], *, loaded: bool = False):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.url.path == "/node/health":
            return httpx.Response(200, json={"available": True, "loaded": loaded})
        if request.url.path == "/node/warm":
            return httpx.Response(200, json={"loaded": True, "detail": "loaded"})
        return httpx.Response(200, json={"unloaded": True})

    return httpx.MockTransport(handler)


def _warming_backend(calls: list[str], *, loaded: bool = False):
    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")
    backend._client = httpx.Client(
        base_url="http://gpu-box:8002", transport=_warming_node(calls, loaded=loaded)
    )
    backend._model_version = "omnivoice-1"
    return backend


def test_a_cold_node_is_loaded_before_synthesis_not_during_it():
    """The load has to happen on a call whose timeout expects it.

    It used to happen inside /node/synthesize, inheriting the ordinary request
    timeout -- so a preview against a cold cloning model timed out rather than
    just being slow.
    """
    calls: list[str] = []
    _warming_backend(calls).prepare()

    assert "POST /node/warm" in calls, "the model was left to load during synthesis"
    assert calls.index("POST /node/unload") < calls.index("POST /node/warm")


def test_loading_uses_the_longer_timeout():
    """Sized for a load, not for a chunk -- a first load downloads weights."""
    seen: list[float | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/node/health":
            return httpx.Response(200, json={"available": True, "loaded": False})
        if request.url.path == "/node/warm":
            seen.append(request.extensions.get("timeout", {}).get("read"))
            return httpx.Response(200, json={"loaded": True})
        return httpx.Response(200, json={"unloaded": True})

    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")
    backend._client = httpx.Client(
        base_url="http://gpu-box:8002", transport=httpx.MockTransport(handler)
    )
    backend._model_version = "omnivoice-1"

    backend.prepare()

    assert seen == [backend._warm_timeout]
    assert backend._warm_timeout > backend._timeout


def test_a_warm_node_is_not_asked_to_load_again():
    calls: list[str] = []
    _warming_backend(calls, loaded=True).prepare()

    assert "POST /node/warm" not in calls
    assert "POST /node/unload" not in calls


def test_warming_marks_the_node_as_holding_the_card():
    """Otherwise the preview straight after would evict and reload again."""
    backend = _warming_backend([], loaded=True)

    backend.warm()

    assert backend._holds_card()


def test_a_failed_warm_is_not_an_error():
    """It is an optimisation; the preview itself should report the real fault."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/node/health":
            return httpx.Response(200, json={"available": True, "loaded": True})
        raise httpx.ConnectError("node is down")

    backend = remote({"omnivoice": "http://gpu-box:8002"}, base="http://gpu-box:8002")
    backend._client = httpx.Client(
        base_url="http://gpu-box:8002", transport=httpx.MockTransport(handler)
    )
    backend._model_version = "omnivoice-1"

    assert backend.warm() is False


def test_health_does_not_load_the_model():
    """The probe must not do the thing it is probing for.

    /node/health used to read `device`, which loads the model to discover
    which execution provider onnxruntime picked. That made it useless as a
    "are you loaded?" check twice over: the answer was always yes, and asking
    loaded the model *before* the sibling holding the card had been evicted --
    the out-of-memory error the eviction exists to prevent.
    """
    from fastapi.testclient import TestClient

    from naudiobooker.config import Settings
    from naudiobooker.main import create_app
    from naudiobooker.tts.kokoro_local import KokoroLocalBackend

    settings = Settings(role="worker-node")
    backend = KokoroLocalBackend(settings)
    loads: list[int] = []
    backend._load = lambda: loads.append(1)  # type: ignore[method-assign]

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr("naudiobooker.config.get_settings", lambda: settings)
        mp.setattr("naudiobooker.main.get_settings", lambda: settings)
        mp.setattr("naudiobooker.routes.node.get_settings", lambda: settings)
        mp.setattr("naudiobooker.routes.node.get_backend", lambda *a, **k: backend)
        with TestClient(create_app()) as client:
            body = client.get("/node/health").json()

    assert loads == [], "health loaded the model just to answer"
    assert body["loaded"] is False
    assert body["provider"] is None


def test_warm_endpoint_never_500s_when_the_node_is_down():
    """Warming is optional; a node that is down is a report, not a failure.

    It used to raise straight through: describing the node contacts it, and
    that call sat outside the try, so an unreachable node produced a 500 and
    the UI showed a generic error instead of the reason.
    """
    from fastapi.testclient import TestClient

    from naudiobooker.config import Settings
    from naudiobooker.main import create_app
    from naudiobooker.tts.remote_http import RemoteHttpBackend

    settings = Settings(
        tts_backend="remote",
        remote_worker_url="http://gpu-box:8002",
        remote_model_urls={"chatterbox-original": "http://gpu-box:8003"},
    )
    backend = RemoteHttpBackend(
        settings, model_id="chatterbox-original", base_url="http://gpu-box:8003"
    )

    def dead(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    backend._client = httpx.Client(
        base_url="http://gpu-box:8003", transport=httpx.MockTransport(dead)
    )

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr("naudiobooker.routes.voices.get_settings", lambda: settings)
        mp.setattr("naudiobooker.routes.voices.get_backend", lambda *a, **k: backend)
        with TestClient(create_app()) as client:
            warm = client.post("/models/chatterbox-original/warm")
            status = client.get("/models/chatterbox-original/warm")

    assert warm.status_code == 200
    assert warm.json()["warmed"] is False
    assert status.status_code == 200
    assert status.json()["warm"] is False

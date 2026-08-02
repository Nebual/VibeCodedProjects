"""The model picked in the UI must be the model that actually renders.

These exist because both routes silently ignored the caller's model for a
while. Nothing failed: preview and render fell back to the configured default,
create_job's ``model`` column defaulted to "kokoro", and the only visible
symptom was Kokoro rejecting a cloned voice it had never heard of. Every
assertion here is on observable state -- the job row, the backend that got the
call -- rather than on the routes being written a particular way.
"""

from __future__ import annotations

import io

import numpy as np
import pytest
import soundfile as sf
from conftest import EpubBuilder, nav_doc, paragraphs
from fastapi.testclient import TestClient
from test_tts import FakeBackend

from naudiobooker import jobs as job_queue
from naudiobooker import store
from naudiobooker.config import Settings
from naudiobooker.db import init_db
from naudiobooker.main import create_app
from naudiobooker.tts import reset_backends
from naudiobooker.voices import VoiceLibrary


@pytest.fixture
def env(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data", models_dir=tmp_path / "models")
    settings.ensure_dirs()
    init_db(settings.db_path)

    monkeypatch.setattr("naudiobooker.config.get_settings", lambda: settings)
    for module in (
        "naudiobooker.db",
        "naudiobooker.store",
        "naudiobooker.voices",
        "naudiobooker.jobs",
        "naudiobooker.routes.tts",
        "naudiobooker.routes.jobs",
        "naudiobooker.routes.voices",
    ):
        monkeypatch.setattr(f"{module}.get_settings", lambda: settings, raising=False)
    reset_backends()
    yield settings
    reset_backends()


@pytest.fixture
def backends(env, monkeypatch) -> dict[str, FakeBackend]:
    """One fake per model family, so which one ran is observable.

    Patched at _local_backend rather than at get_backend: the registry's own
    dispatch on model id is part of what these tests are checking.
    """
    instances: dict[str, FakeBackend] = {}

    def build(settings, spec):
        fake = instances.setdefault(spec.family, FakeBackend())
        fake.id = spec.family
        fake.model_version = f"{spec.family}-1"
        return fake

    monkeypatch.setattr("naudiobooker.tts.registry._local_backend", build)
    return instances


@pytest.fixture
def clip(env):
    """A real uploaded clip, hashed the way the library hashes uploads."""
    tone = (np.sin(2 * np.pi * 180 * np.arange(24_000 * 4) / 24_000) * 0.4).astype(np.float32)
    buffer = io.BytesIO()
    sf.write(buffer, tone, 24_000, format="WAV", subtype="PCM_16")
    return VoiceLibrary.open().add("Narrator", buffer.getvalue())


@pytest.fixture
def book(env, tmp_path):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", paragraphs(3, "alpha"))
    b.nav = nav_doc([("c1.xhtml", "Chapter One")])
    path = b.write(tmp_path / "book.epub")
    return store.create_book(path.read_bytes(), "book.epub")


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------


def test_preview_runs_on_the_requested_model(backends, clip) -> None:
    with TestClient(create_app()) as client:
        res = client.post(
            "/preview",
            json={"voice": clip.id, "model": "omnivoice", "text": "a few words"},
        )

    assert res.status_code == 200, res.text
    assert "omnivoice" in backends, "the requested model never ran"
    assert "kokoro" not in backends, "the default model ran instead"
    assert backends["omnivoice"].calls[0][0] == "a few words"


def test_preview_hands_the_cloned_voice_to_the_model(backends, clip) -> None:
    with TestClient(create_app()) as client:
        res = client.post(
            "/preview",
            json={"voice": clip.id, "model": "chatterbox-original", "text": "hello"},
        )

    assert res.status_code == 200, res.text
    reference = backends["chatterbox"].references[0]
    assert reference is not None, "the clip was dropped on the way to the backend"
    assert reference.ref_hash == clip.ref_hash
    assert reference.path.exists()


def test_preview_still_defaults_to_the_configured_model(backends) -> None:
    with TestClient(create_app()) as client:
        res = client.post("/preview", json={"voice": "fk_ann", "text": "hello"})

    assert res.status_code == 200, res.text
    assert set(backends) == {"kokoro"}


def test_preview_rejects_a_cloned_voice_on_a_model_that_cannot_clone(backends, clip) -> None:
    with TestClient(create_app()) as client:
        res = client.post("/preview", json={"voice": clip.id, "model": "kokoro"})

    assert res.status_code == 400
    # The message has to name the fix; "voice not found" is what sent someone
    # hunting through Kokoro's voice list for a clip that was never there.
    detail = res.json()["detail"]
    assert "cloned voice" in detail
    assert "Kokoro" in detail


def test_preview_rejects_a_cloning_model_with_no_clip(backends) -> None:
    with TestClient(create_app()) as client:
        res = client.post("/preview", json={"voice": "af_heart", "model": "omnivoice"})

    assert res.status_code == 400
    assert "no voice clip" in res.json()["detail"].lower()


def test_preview_rejects_an_unknown_model(backends) -> None:
    with TestClient(create_app()) as client:
        res = client.post("/preview", json={"voice": "af_heart", "model": "tortoise"})

    assert res.status_code == 400
    assert "tortoise" in res.json()["detail"]


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------


def test_render_records_the_model_and_clip_on_the_job(backends, book, clip) -> None:
    with TestClient(create_app()) as client:
        res = client.post(
            f"/books/{book.id}/render",
            json={"voice": clip.id, "model": "chatterbox-original"},
        )

    assert res.status_code == 201, res.text
    # Read back through the queue, not the response: the worker reads the row,
    # and an INSERT that drops a column looks fine in the response body.
    job = job_queue.get_job(res.json()["id"])
    assert job.model == "chatterbox-original"
    assert job.voice_ref == clip.ref_hash
    assert job.model_version == "chatterbox-1"


def test_render_defaults_to_the_configured_model(backends, book) -> None:
    with TestClient(create_app()) as client:
        res = client.post(f"/books/{book.id}/render", json={"voice": "af_heart"})

    assert res.status_code == 201, res.text
    job = job_queue.get_job(res.json()["id"])
    assert job.model == "kokoro"
    assert job.voice_ref is None


def test_render_rejects_a_cloned_voice_on_kokoro(backends, book, clip) -> None:
    with TestClient(create_app()) as client:
        res = client.post(f"/books/{book.id}/render", json={"voice": clip.id})

    assert res.status_code == 400
    assert "cloned voice" in res.json()["detail"]
    # A rejected request must not leave a queued job behind.
    assert job_queue.active_job_for_book(book.id) is None


def test_render_rejects_a_clip_that_no_longer_exists(backends, book, clip) -> None:
    VoiceLibrary.open().remove(clip.id)

    with TestClient(create_app()) as client:
        res = client.post(
            f"/books/{book.id}/render",
            json={"voice": clip.id, "model": "omnivoice"},
        )

    assert res.status_code == 400
    assert "no voice clip" in res.json()["detail"].lower()

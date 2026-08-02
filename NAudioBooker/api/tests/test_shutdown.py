"""Worker shutdown.

A stopping worker is not a cancelled job. Getting that distinction wrong means
a routine container restart marks a nine-hour render as cancelled, and the user
has to notice and restart it by hand.
"""

from __future__ import annotations

import signal
import threading

import pytest
from conftest import EpubBuilder, nav_doc, paragraphs
from test_tts import FakeBackend

from naudiobooker import jobs, store
from naudiobooker.config import Settings
from naudiobooker.db import init_db
from naudiobooker.worker.runner import (
    RenderWorker,
    ShuttingDown,
    _install_signal_handlers,
    process_job,
)


@pytest.fixture
def env(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data", models_dir=tmp_path / "models")
    settings.ensure_dirs()
    init_db(settings.db_path)
    monkeypatch.setattr("naudiobooker.config.get_settings", lambda: settings)
    for module in ("naudiobooker.db", "naudiobooker.store", "naudiobooker.worker.runner"):
        monkeypatch.setattr(f"{module}.get_settings", lambda: settings, raising=False)
    return settings


@pytest.fixture
def backend(monkeypatch) -> FakeBackend:
    fake = FakeBackend()
    monkeypatch.setattr("naudiobooker.worker.runner.get_backend", lambda *a, **k: fake)
    return fake


@pytest.fixture
def book(env, tmp_path):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", paragraphs(6, "alpha"))
    b.add_doc("c2", "c2.xhtml", paragraphs(6, "beta"))
    b.nav = nav_doc([("c1.xhtml", "Chapter One"), ("c2.xhtml", "Chapter Two")])
    return store.create_book(b.write(tmp_path / "book.epub").read_bytes(), "book.epub")


def make_job(book):
    return jobs.create_job(
        book_id=book.id,
        voice="fk_ann",
        speed=1.0,
        backend="fake",
        model_version="fake-1",
        chapters=[(c.index, c.title) for c in book.chapters if c.include],
    )


def test_shutdown_requeues_rather_than_cancelling(env, book, backend):
    job = make_job(book)
    claimed = jobs.claim_next_job()
    stop = threading.Event()
    stop.set()

    with pytest.raises(ShuttingDown):
        process_job(claimed, env, stop)

    after = jobs.get_job(job.id)
    assert after.status == "queued"
    assert after.started_at is None
    # Emphatically not "cancelled": nobody asked for this to stop.
    assert not after.is_terminal


def test_a_requeued_job_can_be_claimed_again(env, book, backend):
    make_job(book)
    stop = threading.Event()
    stop.set()
    with pytest.raises(ShuttingDown):
        process_job(jobs.claim_next_job(), env, stop)

    assert jobs.claim_next_job() is not None


def test_shutdown_mid_render_keeps_completed_chunks(env, book, backend):
    """Resuming after a restart must not re-synthesize what was already done."""
    job = make_job(book)
    stop = threading.Event()

    original = backend.synthesize
    calls = {"n": 0}

    def stop_partway(text, voice, speed=1.0, reference=None):
        calls["n"] += 1
        if calls["n"] == 6:
            stop.set()
        return original(text, voice, speed, reference)

    backend.synthesize = stop_partway
    with pytest.raises(ShuttingDown):
        process_job(jobs.claim_next_job(), env, stop)
    partial = calls["n"]

    backend.synthesize = original
    process_job(jobs.claim_next_job(), env)

    finished = jobs.get_job(job.id)
    assert finished.status == "done"
    assert finished.cache_hits >= partial - 1


def test_worker_loop_exits_on_shutdown(env, book, backend):
    make_job(book)
    worker = RenderWorker(settings=env)
    worker.stop.set()

    worker.run()  # returns rather than hanging

    assert jobs.get_job(jobs.list_jobs()[0].id).status == "queued"


def test_sigterm_is_handled_rather_than_left_to_the_default(env):
    """Without an explicit handler the kernel skips SIGTERM for PID 1.

    That is not a theoretical concern: it is why `docker stop` sat through its
    full ten-second grace period and then SIGKILLed the worker mid-render.
    """
    worker = RenderWorker(settings=env)
    previous = signal.getsignal(signal.SIGTERM)
    try:
        _install_signal_handlers(worker)
        handler = signal.getsignal(signal.SIGTERM)
        assert callable(handler)
        assert handler is not signal.SIG_DFL

        handler(signal.SIGTERM, None)
        assert worker.stop.is_set()
    finally:
        signal.signal(signal.SIGTERM, previous)

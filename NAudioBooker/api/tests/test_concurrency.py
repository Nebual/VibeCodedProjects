"""Concurrent chunk synthesis inside a chapter.

Kokoro's ONNX graph is fixed at batch 1, so overlapping separate calls is the
only way to keep a GPU busy. The property that matters is that it changes
nothing observable except wall-clock: same audio, same bytes, same counters.
"""

from __future__ import annotations

import hashlib
import threading
import time

import numpy as np
import pytest
from conftest import EpubBuilder, nav_doc, paragraphs
from test_tts import FakeBackend

from naudiobooker import jobs, store
from naudiobooker.config import Settings
from naudiobooker.db import init_db
from naudiobooker.text import chunk_paragraphs
from naudiobooker.worker.runner import _in_order, process_job


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
    b.add_doc("c1", "c1.xhtml", paragraphs(12, "alpha"))
    b.add_doc("c2", "c2.xhtml", paragraphs(9, "beta"))
    b.nav = nav_doc([("c1.xhtml", "Chapter One"), ("c2.xhtml", "Chapter Two")])
    path = b.write(tmp_path / "book.epub")
    return store.create_book(path.read_bytes(), "book.epub")


def make_job(book):
    return jobs.create_job(
        book_id=book.id,
        voice="fk_ann",
        speed=1.0,
        backend="fake",
        model_version="fake-1",
        chapters=[(c.index, c.title) for c in book.chapters if c.include],
    )


def render(env, book, concurrency: int):
    env.render_concurrency = concurrency
    make_job(book)
    job = jobs.claim_next_job()
    process_job(job, env)
    return jobs.get_job(job.id)


# ---------------------------------------------------------------------------
# The ordering helper on its own
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("concurrency", [1, 2, 4, 8])
def test_results_come_back_in_order(concurrency) -> None:
    """Out-of-order output would splice a chapter's sentences into nonsense."""
    items = list(range(50))

    # Later items finish sooner, so anything yielding on completion order
    # rather than submission order will visibly scramble.
    def work(n: int) -> int:
        time.sleep((50 - n) * 0.0002)
        return n

    assert list(_in_order(work, items, concurrency)) == items


def test_work_actually_overlaps() -> None:
    """Otherwise this is an elaborate way to write a for loop."""
    live, peak, lock = 0, 0, threading.Lock()

    def work(n: int) -> int:
        nonlocal live, peak
        with lock:
            live += 1
            peak = max(peak, live)
        time.sleep(0.02)
        with lock:
            live -= 1
        return n

    list(_in_order(work, list(range(12)), 4))
    assert peak > 1, "calls never ran at the same time"


def test_each_item_is_handled_exactly_once() -> None:
    seen, lock = [], threading.Lock()

    def work(n: int) -> int:
        with lock:
            seen.append(n)
        return n

    list(_in_order(work, list(range(30)), 3))
    assert sorted(seen) == list(range(30))


def test_look_ahead_is_bounded() -> None:
    """An unbounded pool would hold every finished chunk of a novel in memory."""
    concurrency = 2
    submitted, lock = 0, threading.Lock()

    def work(n: int) -> int:
        nonlocal submitted
        with lock:
            submitted += 1
        time.sleep(0.01)
        return n

    gen = _in_order(work, list(range(100)), concurrency)
    next(gen)
    time.sleep(0.05)
    with lock:
        ahead = submitted
    gen.close()
    assert ahead <= concurrency + 2, f"{ahead} chunks in flight for concurrency {concurrency}"


def test_an_exception_reaches_the_caller() -> None:
    def work(n: int) -> int:
        if n == 5:
            raise RuntimeError("chunk exploded")
        return n

    with pytest.raises(RuntimeError, match="exploded"):
        list(_in_order(work, list(range(20)), 3))


# ---------------------------------------------------------------------------
# Through a real render
# ---------------------------------------------------------------------------


def test_concurrent_render_is_byte_identical(env, backend, book, tmp_path, monkeypatch) -> None:
    """The whole safety argument: concurrency changes timing, nothing else.

    Driven through _render_chapter rather than a full job, because
    finalisation replaces the intermediate WAV with an encoded MP3 -- and the
    WAV is the artefact whose sample ordering is under test.
    """
    from naudiobooker.cache import ChunkCache
    from naudiobooker.tts.base import AudioChunk
    from naudiobooker.worker.runner import _Progress, _render_chapter

    # FakeBackend emits the same tone for any two chunks of equal length, so
    # reordering them is invisible in the output -- this test passed against a
    # deliberately broken _in_order until the audio was made distinguishable.
    def marked(text, voice, speed=1.0, reference=None, options=None):
        mark = int.from_bytes(hashlib.sha256(text.encode()).digest()[:2], "big") / 65535
        length = 400 + len(text)
        return AudioChunk(
            samples=np.full(length, mark, dtype=np.float32), sample_rate=backend.sample_rate
        )

    monkeypatch.setattr(backend, "synthesize", marked)

    job = make_job(book)
    chunks = chunk_paragraphs(store.chapter_text(book.id, 0).paragraphs, backend.max_chars)
    assert len(chunks) > 4, "too few chunks for ordering to be observable"

    outputs = {}
    for concurrency in (1, 4):
        # A shared cache would let the second pass copy the first's answers,
        # which would prove nothing about ordering under real synthesis.
        cache = ChunkCache(tmp_path / f"cache-{concurrency}")
        destination = tmp_path / f"chapter-{concurrency}.wav"
        _render_chapter(
            job=job,
            chapter_index=0,
            chunks=chunks,
            backend=backend,
            cache=cache,
            destination=destination,
            progress=_Progress(),
            concurrency=concurrency,
        )
        outputs[concurrency] = destination.read_bytes()

    assert outputs[1] == outputs[4], "concurrent render produced different audio"


def test_concurrency_does_not_change_the_counters(env, backend, book) -> None:
    from naudiobooker.cache import ChunkCache

    serial = render(env, book, concurrency=1)
    serial_calls = len(backend.calls)

    ChunkCache(env.cache_dir).clear()
    backend.calls.clear()
    parallel = render(env, book, concurrency=3)

    assert parallel.status == serial.status == "done"
    assert parallel.chunks_done == serial.chunks_done
    assert parallel.chunks_total == serial.chunks_total
    # Every chunk synthesized exactly once, not once per worker.
    assert len(backend.calls) == serial_calls == serial.chunks_total


def test_a_second_render_still_hits_the_cache_under_concurrency(env, backend, book) -> None:
    render(env, book, concurrency=3)
    backend.calls.clear()

    again = render(env, book, concurrency=3)

    assert again.cache_hits == again.chunks_total
    assert backend.calls == []
